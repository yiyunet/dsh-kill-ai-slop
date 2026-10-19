/**
 * 义务台账（案 A 核心层）的回归测试。
 *
 * 这一层的价值不在"算出分数"，而在**拒绝接受无法核对的判断**。
 * 所以测试的重点不是"判对了没有"，而是"对不上原文时它有没有拒绝"。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { auditObligations, verifyQuote } from '../plugin-src/host/obligations.mjs'

const DOC = [
  '# 渠道方案',
  '首轮优先推进 PartsTech，其余渠道暂缓。',
  '优先级表把 PartsTech 排在 P2。',
  '不直接铺大众电商，仅用于专业维修场景。',
].join('\n')

/* ───────────────── 引文复核：唯一真正"确定"的能力 ───────────────── */

test('存在的引文返回真实行号', () => {
  const result = verifyQuote(DOC, '其余渠道暂缓')
  assert.equal(result.ok, true)
  assert.equal(result.line, 2)
})

test('编造的引文一律不通过', () => {
  const result = verifyQuote(DOC, '我们已获得平台书面批准')
  assert.equal(result.ok, false)
  assert.match(result.reason, /找不到/u)
})

test('行号错了要报出来，并给出正确行号', () => {
  const result = verifyQuote(DOC, '其余渠道暂缓', 4)
  assert.equal(result.ok, false)
  assert.equal(result.line, 2)
  assert.match(result.hint ?? '', /第 2 行/u)
})

test('两个字符的代号不能当证据（"P2" 在长文里随机会命中）', () => {
  const result = verifyQuote(DOC, 'P2')
  assert.equal(result.ok, false)
  assert.match(result.reason, /太短|有效字符/u)
})

test('空白引文直接拒绝', () => {
  assert.equal(verifyQuote(DOC, '   ').ok, false)
})

/* ───────────────── 台账：状态自洽与结论闸门 ───────────────── */

test('说"已满足"却拿不出引文 → 违规，且不出结论', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [
      { id: 'O1', question: '首轮做哪个渠道？', origin: 'explicit', coverage: 'met', evidence: [] },
    ],
  })
  assert.equal(report.verdict.band, '不予判定')
  assert.ok(report.violations.some(item => item.field === 'evidence'))
})

test('关键义务缺失 → 需返工，并点名哪一条', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [
      { id: 'O1', question: '首轮做哪个渠道？', origin: 'explicit', coverage: 'missing' },
      {
        id: 'O2',
        question: '首批场景是什么？',
        origin: 'explicit',
        coverage: 'met',
        evidence: [{ quote: '仅用于专业维修场景' }],
      },
    ],
  })
  assert.equal(report.verdict.band, '关键缺口：需返工')
  assert.deepEqual(report.ledger.blocking, ['O1'])
})

test('冲突只给一条证据 → 违规（冲突起码要指得到两处）', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [
      {
        id: 'O1',
        question: 'PartsTech 的优先级到底是什么？',
        origin: 'explicit',
        coverage: 'conflicting',
        evidence: [{ quote: '首轮优先推进 PartsTech' }],
      },
    ],
  })
  assert.ok(report.violations.some(item => /冲突未解/u.test(item.reason)))
})

test('引文对不上 → 该条判定降级，结论不得说"满足"', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [
      {
        id: 'O1',
        question: '首轮做哪个渠道？',
        origin: 'explicit',
        coverage: 'met',
        evidence: [{ quote: '首轮优先推进 PartsTech' }, { quote: '已经拿到平台入驻许可' }],
      },
    ],
  })
  assert.equal(report.ledger.degraded.length, 1)
  assert.notEqual(report.verdict.band, '满足本次交付要求')
})

test('没有任务基准时，不判定任务承接', () => {
  const report = auditObligations({
    docText: DOC,
    obligations: [
      {
        id: 'O1',
        question: '首轮做哪个渠道？',
        origin: 'explicit',
        coverage: 'met',
        evidence: [{ quote: '首轮优先推进 PartsTech' }],
      },
    ],
  })
  assert.equal(report.basis.kind, 'none')
  assert.match(report.verdict.band, /无基准/u)
})

test('可选优化项不能单独造成"不满足"', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [
      {
        id: 'O1',
        question: '首轮做哪个渠道？',
        origin: 'explicit',
        coverage: 'met',
        evidence: [{ quote: '首轮优先推进 PartsTech' }],
      },
      { id: 'O2', question: '长期 ROI 测算', origin: 'optional', critical: true, coverage: 'missing' },
    ],
  })
  assert.ok(report.violations.some(item => item.field === 'critical'))
})

test('coverage 用非枚举值 → 违规（状态必须可机器统计）', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [{ id: 'O1', question: '首轮做哪个渠道？', origin: 'explicit', coverage: '没问题' }],
  })
  assert.ok(report.violations.some(item => item.field === 'coverage'))
})

test('全部义务有可核对证据 + 有任务基准 → 才敢说满足', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [
      {
        id: 'O1',
        question: '首轮做哪个渠道？',
        origin: 'explicit',
        coverage: 'met',
        evidence: [{ quote: '首轮优先推进 PartsTech，其余渠道暂缓' }],
      },
      {
        id: 'O2',
        question: '边界在哪里？',
        origin: 'essential',
        coverage: 'met',
        evidence: [{ quote: '不直接铺大众电商' }],
      },
    ],
  })
  assert.equal(report.verdict.band, '满足本次交付要求')
  assert.equal(report.verdict.tentative, false)
})

test('snake_case 字段也能吃（模型两种命名都会写）', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [
      {
        id: 'O1',
        question: '首轮做哪个渠道？',
        origin: 'explicit',
        coverage_status: 'met',
        origin_reason: '落地方案必须给出首轮对象',
        resolution_test: '渠道表与近期任务使用同一顺序',
        evidence: [{ quote: '首轮优先推进 PartsTech，其余渠道暂缓', line_no: 2 }],
      },
    ],
  })
  const item = report.obligations[0]
  assert.equal(item.coverage, 'met')
  assert.equal(item.status, 'confirmed')
  assert.equal(item.verifiedCount, 1)
})

test('台账按金字塔排：结论在最前，元信息在最后，且不含章节序号', () => {
  const report = auditObligations({
    docText: DOC,
    task: '出一个落地方案',
    obligations: [{ id: 'O1', question: '首轮做哪个渠道？', origin: 'explicit', coverage: 'missing' }],
  })
  const md = report.markdown

  // 结论必须出现在正文靠前的位置：一条 missing 的关键义务 → 需返工
  assert.match(md, /关键缺口：需返工/u)
  assert.ok(md.indexOf('关键缺口：需返工') < md.indexOf('O1 首轮做哪个渠道'), '结论必须排在逐条之前')

  // 元信息下沉到文末：schema 不得出现在前 300 字里
  assert.ok(md.indexOf('规则集 schema') > 300, 'schema 等元信息必须下沉到文末')

  // 边界节在，且排在最后
  assert.match(md, /本次没判什么/u)

  // 章节不再编号 —— 编号是排版不是信息，嵌进别的文书只会制造两套编号
  assert.doesNotMatch(md, /^## [一二三四五六七八九十]+、/mu)
})

test('原文为空时不出台账（没有原文就无从复核）', () => {
  assert.throws(
    () => auditObligations({ docText: '   ', task: 'x', obligations: [{ id: 'O1' }] }),
    error => error.code === 'NO_TEXT',
  )
})

test('义务表为空时不出台账（不替评审方编义务）', () => {
  assert.throws(
    () => auditObligations({ docText: DOC, task: 'x', obligations: [] }),
    error => error.code === 'NO_OBLIGATIONS',
  )
})

test('basis=task 却没给任务原文 → 拒绝', () => {
  // 断言断的是**错误码**，不是文案。
  // 教训：断字符串的断言会在改写提示语时假报警 —— 它测的是我怎么说，不是程序怎么做。
  assert.throws(
    () => auditObligations({ docText: DOC, basis: 'task', obligations: [{ id: 'O1', question: 'q', coverage: 'missing' }] }),
    error => error.code === 'TASK_REQUIRED',
  )
})
