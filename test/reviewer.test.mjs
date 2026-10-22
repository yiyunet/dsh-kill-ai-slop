/**
 * 面板侧评审器 —— 只测**可争论之外**的东西。
 *
 * 这里不测"模型判得对不对"（测不了），只测：
 *   提示词是否把 12 格与 6 条协议都带上了；流式拼字与终态处理是否正确；
 *   模型返回的 JSON 能不能被稳妥地取出来；超长文档是否被拒绝而不是截断。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_REVIEW_CHARS,
  buildSystemPrompt,
  buildUserPrompt,
  collectStream,
  extractReviewJson,
  generateReview,
  listReviewModels,
} from '../plugin-src/host/reviewer.mjs'
import { RUBRIC_ORDER } from '../plugin-src/host/rubric.mjs'

async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

const okStream = text => streamOf([
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
])

test('系统提示带全部 12 格与协议（规程固定，不随调用漂移）', () => {
  const system = buildSystemPrompt()
  for (const id of RUBRIC_ORDER) {
    assert.match(system, new RegExp(`### ${id} `, 'u'), `系统提示缺格 ${id}`)
  }
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']) {
    assert.match(system, new RegExp(`${id} 【`, 'u'), `系统提示缺协议 ${id}`)
  }
  // 0.7.12：8 分档已停用 —— 它把"无害差异"写成扣分，等于把满分定义成完美格式
  assert.doesNotMatch(system, /^ {6}8 分：/mu)
  // 最容易被模型忽略、也最关键的两条要求
  assert.match(system, /逐字原样摘自原文/u)
  assert.match(system, /只输出\*\*一个 JSON 对象\*\*/u)
})

test('用户提示带原文与首尾标记；没任务时要求 basis=none', () => {
  const withTask = buildUserPrompt({ docText: '第一行\n第二行', task: '出一份复盘' })
  assert.match(withTask, /<<<原文开始>>>/u)
  assert.match(withTask, /<<<原文结束>>>/u)
  assert.match(withTask, /第一行\n第二行/u)
  assert.match(withTask, /出一份复盘/u)

  const withoutTask = buildUserPrompt({ docText: 'x' })
  assert.match(withoutTask, /basis 填 "none"/u)
  assert.doesNotMatch(withoutTask, /原始任务原话（评价基准）/u)
})

test('流式拼字：多段 text-delta 累加，usage 与终态可取', async () => {
  const usage = { input: 10, output: 5 }
  const result = await collectStream(streamOf([
    { type: 'text-delta', index: 0, text: '{"a"' },
    { type: 'reasoning-delta', index: 1, text: '想一下' },
    { type: 'text-delta', index: 0, text: ':1}' },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]))
  assert.equal(result.text, '{"a":1}')
  assert.deepEqual(result.usage, usage)
  assert.equal(result.finish, 'stop')
})

test('进度回调按累计字数触发', async () => {
  const lengths = []
  await collectStream(okStream('abcdef'), { onProgress: n => lengths.push(n) })
  assert.deepEqual(lengths, [6])
})

test('模型报错或中断 → 抛出可诊断错误，不返回半截文本', async () => {
  await assert.rejects(
    () => collectStream(streamOf([
      { type: 'text-delta', index: 0, text: '半截' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '限流' } } },
    ])),
    /RATE_LIMIT/u,
  )
  await assert.rejects(
    () => collectStream(streamOf([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'X', message: '取消' } } }])),
    /aborted/u,
  )
})

test('没有终态的流 → 报"意外结束"', async () => {
  await assert.rejects(
    () => collectStream(streamOf([{ type: 'text-delta', index: 0, text: 'abc' }])),
    /没有收到终态/u,
  )
})

test('截断终态（length）不算成功', async () => {
  await assert.rejects(
    () => collectStream(streamOf([{ type: 'finish', reason: { kind: 'length' } }])),
    /截断/u,
  )
})

test('模型输出带 ```json 围栏或前后废话，仍能取出那一个对象', () => {
  assert.deepEqual(extractReviewJson('```json\n{"basis":"none"}\n```'), { basis: 'none' })
  assert.deepEqual(extractReviewJson('好的，评审如下：{"basis":"none"} 以上。'), { basis: 'none' })
  assert.deepEqual(extractReviewJson('{"a":{"b":1}}'), { a: { b: 1 } })
})

test('字符串里没转义的英文双引号：自动修复，不白跑一次模型', () => {
  // 实测症状（0.7.9）：note 里写了 他说"这个不行"" —— 内层引号把字符串提前闭合，
  // JSON.parse 报 `Expected ',' or '}' after property value`。
  const raw = '{"cells":[{"id":"V1","note":"他说"这个不行"，我同意"}]}'
  assert.deepEqual(extractReviewJson(raw), { cells: [{ id: 'V1', note: '他说"这个不行"，我同意' }] })
  // 键上的引号不能误伤
  assert.deepEqual(extractReviewJson('{"a":"b","c":"d"}'), { a: 'b', c: 'd' })
})

test('字符串里出现真实换行：转义后仍能解析', () => {
  const raw = '{"note":"第一行\n第二行"}'
  assert.deepEqual(extractReviewJson(raw), { note: '第一行\n第二行' })
})

test('委托方声明（文档类型 / 期望产出）必须喂给模型，且不许用来放水', () => {
  // ★ 0.7.11：面板上那两个下拉以前只进了旧维度与提炼页，模型一个字收不到 ——
  //   而判定规程里 V2 的"纯记录类不承担论证义务"、E1 的"纯分析类可判不适用"都依赖体裁。
  const prompt = buildUserPrompt({
    docText: '正文',
    task: '',
    delivery: {
      docType: 'minutes',
      docTypeLabel: '会议纪要',
      docTypeSpecified: true,
      level: 'card',
      levelLabel: '速读卡片',
      levelDesc: '一屏看完',
    },
  })
  assert.match(prompt, /委托方声明/u)
  assert.match(prompt, /文档类型：\*\*会议纪要\*\*（委托方明确指定/u)
  assert.match(prompt, /期望产出：\*\*速读卡片\*\*/u)
  // 硬约束：声明只改变怎么读，不改变评分标准
  assert.match(prompt, /只影响你怎么读，不影响你用什么尺子量/u)
})

test('选了"自动判断"时不假装用户指定了体裁', () => {
  const prompt = buildUserPrompt({
    docText: '正文',
    delivery: { docType: 'auto', docTypeLabel: '自动判断', docTypeSpecified: false },
  })
  assert.match(prompt, /自己从全文认定体裁/u)
  assert.doesNotMatch(prompt, /委托方明确指定/u)
})

test('取不出 JSON 时报错并带原文片段（便于排查模型跑偏）', () => {
  assert.throws(() => extractReviewJson(''), /空内容/u)
  assert.throws(() => extractReviewJson('完全没有大括号'), /没有找到 JSON/u)
  assert.throws(() => extractReviewJson('{不是合法 JSON}'), /不合法/u)
  assert.throws(() => extractReviewJson('[1,2,3]'), /不是一个 JSON 对象/u)
})

test('超长文档直接拒绝，不截断（截断会毁掉"通读全文"这个前提）', async () => {
  const long = 'x'.repeat(MAX_REVIEW_CHARS + 1)
  await assert.rejects(
    () => generateReview({ llm: { stream: () => okStream('{}') }, docText: long, provider: 'p', model: 'm' }),
    /超过单次评审上限/u,
  )
})

test('没有 llm.stream 时明确报"宿主未提供"', async () => {
  await assert.rejects(
    () => generateReview({ llm: {}, docText: 'abc', provider: 'p', model: 'm' }),
    /llm 服务/u,
  )
})

test('generateReview 走通：拼 options、取 JSON', async () => {
  let seen
  const llm = {
    stream(options) {
      seen = options
      return okStream('{"basis":"none","understanding":{}}')
    },
  }
  const result = await generateReview({ llm, docText: '第一行', provider: 'p1', model: 'm1', task: '出方案' })
  assert.equal(result.review.basis, 'none')
  assert.equal(seen.provider, 'p1')
  assert.equal(seen.model, 'm1')
  assert.equal(seen.temperature, 0)
  assert.match(seen.system, /十二条判定规程/u)
  assert.match(seen.messages[0].content[0].text, /第一行/u)
})

test('模型清单：兼容同步 listProviders 与异步 listModels', async () => {
  const sync = {
    listProviders: () => [{ id: 'p1', name: 'P1' }, { id: 'p2' }],
    listModels: id => Promise.resolve(id === 'p1' ? [{ id: 'm1', name: 'M1' }] : []),
  }
  const list = await listReviewModels(sync)
  assert.deepEqual(list, [
    { id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] },
    { id: 'p2', name: 'p2', models: [] },
  ])
})

test('listModels 抛错时该 provider 记空清单，不炸整份清单', async () => {
  const list = await listReviewModels({
    listProviders: () => [{ id: 'broken' }],
    listModels: () => { throw new Error('catalog offline') },
  })
  assert.deepEqual(list, [{ id: 'broken', name: 'broken', models: [] }])
})

test('没有 listProviders 时返回空数组', async () => {
  assert.deepEqual(await listReviewModels({}), [])
})
