import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DOC_TYPES, RULESET_ENGINE, RULESET_VERSION, evaluateAll, inferDocType } from '../plugin-src/host/rules.mjs'
import { computeIndex, computeScores, confidenceOf, verdictOf } from '../plugin-src/host/score.mjs'
import { ENGINE_VERSION } from '../plugin-src/host/audit.mjs'
import { distill } from '../plugin-src/host/distill.mjs'
import { hardProtection } from '../plugin-src/host/text.mjs'

const dim = (id, index, weight, state, severity = 0) => ({ id, index, label: id, weight, state, severity, hits: [] })
const pick = (evaluation, id) => evaluation.dimensions.find(dimension => dimension.id === id)

/* ───────────────────────── 规则 ───────────────────────── */

test('套话密集的文本：A1 严重度 ≥ 2', () => {
  const text = '随着行业的快速发展，我们要高度重视这项工作。我们要赋能一线，我们要形成合力，我们要形成闭环。'
  const evaluation = evaluateAll(text)
  const a1 = pick(evaluation, 'A1')
  assert.equal(a1.state, 'scored')
  assert.ok(a1.severity >= 2, `A1 严重度应 ≥2，实际 ${a1.severity}`)
})

test('事实密集型文本：A1 零命中且不虚报', () => {
  const text = '10 月 15 日实测：A 方案耗时 3.2 小时，B 方案耗时 4.8 小时。差额 1.6 小时，按每小时 400 元计，单次节省 640 元。'
  const evaluation = evaluateAll(text)
  const a1 = pick(evaluation, 'A1')
  assert.equal(a1.severity, 0)
  assert.equal(a1.hits.length, 0)
})

test('引号内的套话不计入水分（如实引用对方原话不该被罚）', () => {
  const text = '对方原话是「我们要赋能一切、形成闭环」，我们没有采纳。'
  const evaluation = evaluateAll(text)
  assert.equal(pick(evaluation, 'A1').severity, 0)
})

test('程度词带数字时按保护项放过，并在补充里说明', () => {
  const text = '成本显著下降 35%，交付周期缩短 2 天。'
  const evaluation = evaluateAll(text)
  const a4 = pick(evaluation, 'A4')
  assert.equal(a4.severity, 0)
  assert.match(a4.note ?? '', /保护项/u)
})

test('程度词无任何量级时命中 A4', () => {
  const evaluation = evaluateAll('成本显著下降。效果极大提升。')
  const a4 = pick(evaluation, 'A4')
  assert.ok(a4.severity >= 1, `A4 应命中，实际 ${a4.severity}`)
})

test('文档类型是适用性开关：会议纪要退出 B3（论证义务）', () => {
  const text = '会议纪要\n议题：Q4 排期。参会人：张三、李四。结论：按 11 月 1 日启动推进。'
  const evaluation = evaluateAll(text, { docType: 'minutes' })
  const b3 = pick(evaluation, 'B3')
  assert.equal(b3.state, 'not-applicable')
  assert.match(b3.reason, /论证/u)
  assert.equal(b3.severity, 0)
})

test('说明类文档退出 B6（执行完整性），避免体裁误伤', () => {
  const evaluation = evaluateAll('本说明介绍空气净化器的基本原理与适用场景。', { docType: 'explainer' })
  assert.equal(pick(evaluation, 'B6').state, 'not-applicable')
})

test('全文无结构元素时 A5 不适用（而不是判 0 分）', () => {
  const evaluation = evaluateAll('这是一段没有任何标题和列表的正文。'.repeat(10))
  assert.equal(pick(evaluation, 'A5').state, 'not-applicable')
})

test('文本过短时 B2 标记为「未能评估」，不与 0 分混淆', () => {
  const evaluation = evaluateAll('太短了。')
  assert.equal(pick(evaluation, 'B2').state, 'insufficient')
})

test('主张句不足 3 条时 B3 标记为「未能评估」', () => {
  const evaluation = evaluateAll('我们认为必须统一口径，因此建议重写。', { docType: 'report' })
  assert.equal(pick(evaluation, 'B3').state, 'insufficient')
})

test('重复片段被 A2 抓出', () => {
  const unit = '我们要把这件事拆成三个步骤来处理'
  const text = `${unit}。具体见下。\n\n${unit}。以上就是全部内容。`
  const evaluation = evaluateAll(text)
  assert.ok(pick(evaluation, 'A2').severity >= 1)
})

test('一处重复只报一条证据，且证据还原成整句而不是滑窗碎片', () => {
  // 实测问题：一句 45 字的重复被漏成 4 条"偏移 1 字"的 8 字碎片（随着市场竞争的不 / 着市场竞争的不断 / …），
  // 每条配一份相同的原因与改法 —— 读者无法从中读出"这里有一整句重复了"。
  const sentence = '随着市场竞争的不断加剧，我们需要全面提升渠道能力，打造高效协同的作战体系'
  const text = `${sentence}。\n\n渠道投入 12 万元。\n\n${sentence}。`
  const a2 = pick(evaluateAll(text), 'A2')
  assert.equal(a2.hits.length, 1, `A2 应只报 1 条，实际 ${a2.hits.length} 条：${JSON.stringify(a2.hits.map(hit => hit.snippet))}`)
  assert.ok(
    a2.hits[0].snippet.includes('打造高效协同的作战体系'),
    `证据应还原到整句，实际只给了：${a2.hits[0].snippet}`,
  )
})

test('数值冲突被 B4 抓出（同指标名不同数值）', () => {
  const text = '项目成本：12 万元。工期：3 周。项目成本：18 万元。人力投入：5 人。'
  const evaluation = evaluateAll(text, { docType: 'report' })
  const b4 = pick(evaluation, 'B4')
  assert.ok(b4.hits.some(hit => hit.rule === 'B4-数值冲突'), `实际命中：${JSON.stringify(b4.hits.map(h => h.rule))}`)
})

/* ───────── 以下三条是"真实文件首次跑出来的误报"，逐条钉住 ───────── */

test('并列描述不算数值冲突：同一句里的分渠道数据不该被判成自相矛盾', () => {
  // 实测误报：被判成「渠道投入 出现 12 / 8 万元两个值」—— 可那是两个渠道各自的投入
  const text = '9月数据显示：A渠道投入12万元带来340单，单均353元；B渠道投入8万元带来410单，单均195元。'
  const evaluation = evaluateAll(text, { docType: 'report' })
  const conflicts = pick(evaluation, 'B4').hits.filter(hit => hit.rule === 'B4-数值冲突')
  assert.equal(conflicts.length, 0, `不该报冲突，实际：${JSON.stringify(conflicts.map(h => h.why))}`)
})

test('非赋值形态的数字不参与一致性比对（必须有「指标：数字」这种形态）', () => {
  const text = 'A 渠道投入 12 万元。B 渠道投入 8 万元。'
  const evaluation = evaluateAll(text, { docType: 'report' })
  assert.equal(pick(evaluation, 'B4').hits.length, 0)
})

test('A1 在含实质内容的文档上封顶 3 级（不判「使交付目标无法完成」）', () => {
  const vacuous = '我们要赋能抓手闭环颗粒度打法。我们要组合拳顶层设计底层逻辑。我们要全方位多维度。'
  const facts = '成本 12 万元。工期 3 周。单均 353 元。单均 195 元。由张三负责。11 月 5 日交付。'
  const evaluation = evaluateAll(`${vacuous}${facts}`, { docType: 'report' })
  const a1 = pick(evaluation, 'A1')
  assert.ok(a1.hits.length >= 10, `应命中 ≥10 个套话词，实际 ${a1.hits.length}`)
  assert.equal(a1.severity, 3, `有 6 句事实句时不该判 4 级，实际 ${a1.severity}（${a1.severityLabel}）`)
})

test('A4 不重复扣已被 A1 收录的词（同处只罚一次）', () => {
  // 「全面提升」同时在 A1 词表与 A4 程度词表里，修前会被两条规则各罚一次
  const evaluation = evaluateAll('我们要实现全面提升，让效率更高。', { docType: 'report' })
  const a4Rules = pick(evaluation, 'A4').hits.map(hit => hit.snippet)
  assert.ok(!a4Rules.includes('全面提升'), 'A4 不该再罚一次 A1 已收录的词')
})

test('inferDocType 从头部结构判断文档类型', () => {
  assert.equal(inferDocType('会议纪要\n参会人：…'), 'minutes')
  assert.equal(inferDocType('关于国庆放假的通知'), 'notice')
  assert.equal(inferDocType('方案：Q4 渠道调整'), 'proposal')
  assert.equal(inferDocType('随便写点什么'), 'generic')
})

test('DOC_TYPES 覆盖 auto 且每个都有中文名', () => {
  assert.ok(DOC_TYPES.some(item => item.id === 'auto'))
  for (const item of DOC_TYPES) assert.ok(item.label.length > 0)
})

test('规则集版本已声明（规则变更必须换版本，否则分数不可比）', () => {
  assert.match(RULESET_VERSION, /^slop-rules\//u)
})

test('规则集与引擎的版本标记必须一致（否则体检会拒绝出分）', () => {
  // 实测故障：热重载只换了 audit.mjs，rules.mjs 还是旧的 ⇒ 报告写"引擎 0.1.1"、
  // 算它的是 0.1.0 的规则，全程不报错。这条断言守住"两个模块是同一版"这个前提。
  assert.equal(RULESET_ENGINE, ENGINE_VERSION,
    `规则集给引擎 ${RULESET_ENGINE} 构建，当前引擎 ${ENGINE_VERSION} —— 必须同批构建`)
})

/* ───────────────────────── 计分 ───────────────────────── */

test('公式：一半维度严重度 4、一半 0，指数为 50', () => {
  const index = computeIndex([dim('B1', 'B', 50, 'scored', 4), dim('B2', 'B', 50, 'scored', 0)], 'B')
  assert.equal(index.value, 50)
})

test('不适用维度退出分母：加一个权重 100 的不适用维度，分数不变', () => {
  const index = computeIndex([
    dim('B1', 'B', 50, 'scored', 4),
    dim('B2', 'B', 50, 'scored', 0),
    dim('B3', 'B', 100, 'not-applicable'),
  ], 'B')
  assert.equal(index.value, 50)
  assert.equal(index.totalWeight, 200)
  assert.equal(index.coveredWeight, 100)
})

test('未能评估维度同样退出分母（不得当作 0 分顶替）', () => {
  const index = computeIndex([
    dim('B1', 'B', 50, 'scored', 4),
    dim('B2', 'B', 50, 'insufficient'),
  ], 'B')
  assert.equal(index.value, 100)
  assert.equal(index.evalCoverage, 0.5)
})

test('全部维度不可评估时不出分，并给出理由', () => {
  const index = computeIndex([dim('B1', 'B', 50, 'insufficient')], 'B')
  assert.equal(index.value, null)
  assert.equal(index.withheld, true)
  // 断语义，不断内部条款编号：要的是"说明了为什么不出分"。
  // 早先这里断言的是一串内部条款编号 —— 那是把内部文档的条款号当成了行为契约，
  // 于是脱敏一改文案，测试就红；而它想保证的行为其实没变。这类耦合会让人误以为改坏了。
  assert.match(index.withheldReason, /未能评估|不出分/u,
    `不出分必须说明原因，实际：${index.withheldReason}`)
})

test('解析覆盖率低于阈值时两个指数都不出分（覆盖不足不出总分）', () => {
  const evaluation = evaluateAll('成本下降 12%，交付 3 周。'.repeat(30), { docType: 'report' })
  const scores = computeScores(evaluation, { parseCoverage: 0.3, minParseCoverage: 0.7 })
  assert.equal(scores.coverage.withheldTotal, true)
  assert.equal(scores.indexA.value, null)
  assert.equal(scores.indexB.value, null)
  assert.equal(scores.headline.available, false)
})

test('解析覆盖率达标但可评估权重偏低时，给分并标「部分结论」', () => {
  const evaluation = evaluateAll('会议纪要\n议题：排期。参会人：张三。结论：11 月启动。', { docType: 'minutes' })
  const scores = computeScores(evaluation, { parseCoverage: 1, minEvalCoverage: 0.9 })
  assert.equal(scores.coverage.withheldTotal, false)
  assert.ok(scores.indexA.partial === true || scores.indexA.value !== null)
})

test('B 退出指数体系后只剩 A 出分，且首页不得把 A 说成主指标', () => {
  const evaluation = evaluateAll('我们要赋能闭环，高度重视，形成合力。'.repeat(8), { docType: 'proposal' })
  const scores = computeScores(evaluation, { parseCoverage: 1 })
  assert.equal(scores.indexB.value, null)
  if (scores.headline.available) {
    assert.equal(scores.headline.index, 'A')
    assert.match(scores.headline.text, /表达体检/u)
    assert.match(scores.headline.text, /交付承接台账/u)
  }
})

test('verdictOf 给档位而不是概率', () => {
  assert.equal(verdictOf('B', 10).band, '可用')
  assert.equal(verdictOf('B', 70).band, '严重空转')
  assert.equal(verdictOf('A', 90).band, '几乎全是水分')
  assert.equal(verdictOf('B', null).band, '未定')
})

test('confidenceOf 不给假概率，只给高低 + 可核理由', () => {
  const high = confidenceOf({ parseCoverage: 1, evalCoverage: 0.9, hitCount: 5, chars: 3000, parseMode: 'exact' })
  assert.ok(['高', '中'].includes(high.level))
  assert.ok(high.reasons.length > 0)
  assert.ok(high.reasons.every(reason => typeof reason === 'string' && reason.length > 0))
  // 可信度理由里不得出现"是 AI 写的概率"这类伪概率
  assert.ok(!/AI/u.test(high.reasons.join('')))

  const low = confidenceOf({ parseCoverage: 0.4, evalCoverage: 0.3, hitCount: 0, chars: 200, parseMode: 'pdf-heuristic' })
  assert.ok(['低', '很低'].includes(low.level))
})

/* ───────── 证据质量：扣分必须指得到一个具体位置 ───────── */

test('全文级命中的证据片段不超过 60 字（太长等于没有证据）', () => {
  // 实测问题：「缺责任人」的证据片段是开头 120 字的一堵墙，读者没法据此定位
  const evaluation = evaluateAll('我们要对齐目标，拉通资源，把颗粒度做细。'.repeat(6), { docType: 'proposal' })
  for (const id of ['B1', 'B6']) {
    for (const hit of pick(evaluation, id).hits) {
      assert.ok(hit.snippet.length <= 60, `${id} 的片段长达 ${hit.snippet.length} 字：${hit.snippet.slice(0, 30)}…`)
    }
  }
})

test('A2 有分必有据：命中为空却给了严重度时，必须在 note 里说明证据缺口', () => {
  const samples = [
    '我们要高度重视渠道运营工作持续赋能一线团队形成合力形成闭环，我们要高度重视渠道运营工作持续赋能一线团队形成合力形成闭环',
    '随着行业的快速发展，我们要高度重视这项工作。随着行业的快速发展，我们要高度重视这项工作。',
  ]
  for (const text of samples) {
    const a2 = pick(evaluateAll(text), 'A2')
    if (a2.severity > 0 && a2.hits.length === 0) {
      assert.match(a2.note ?? '', /无法映射回/u, `给了 ${a2.severity} 级却没说证据缺口：${text.slice(0, 16)}…`)
    }
  }
})

/* ───────── 结构误报回归（外部复核在真实报告上抓到的两处）───────── */

test('父标题紧跟子标题不算空标题', () => {
  // 实测问题：真实报告的默认写法就是「## 一、渠道分析 / ### 1.1 PartsTech」，
  // 旧逻辑"下一个非空行只要是标题就判空"，于是每一个父标题都被误报一次。
  const text = [
    '## 一、渠道分析',
    '### 1.1 PartsTech 准入',
    '先从零件目录切入，首轮只做三个品类。',
    '### 1.2 Summit Racing',
    '它面向改装件，与我们的主力场景重合度低，暂缓推进。',
    '## 二、结论',
    '本轮先做 PartsTech。',
  ].join('\n\n')
  const a5 = pick(evaluateAll(text), 'A5')
  const empty = a5.hits.filter(hit => hit.rule === 'A5-空标题')
  assert.equal(empty.length, 0, `不应有空的父标题，实际报了 ${empty.length} 条：${JSON.stringify(empty.map(h => h.snippet))}`)
})

test('文件末尾的孤立标题仍然算空标题（不能把闸门修没了）', () => {
  const text = ['## 一、现状', '当前没有可用的准入路径。', '## 二、结论'].join('\n\n')
  const a5 = pick(evaluateAll(text), 'A5')
  assert.ok(a5.hits.some(hit => hit.rule === 'A5-空标题'), '末尾孤标题应判空')
})

test('被空行分隔的松散列表算一个列表，不是 N 个单条列表', () => {
  // 实测问题：Markdown 的"松散列表"（项与项之间空一行）是合法写法，
  // 旧逻辑按空行切块，于是每一个列表项都被误报成"单条列表"。
  const text = [
    '## 首轮动作',
    '',
    '- 由渠道负责人提交供应商资料',
    '',
    '- 整理品类准入条款',
    '',
    '- 记录平台的首次回复',
  ].join('\n')
  const a5 = pick(evaluateAll(text), 'A5')
  const single = a5.hits.filter(hit => hit.rule === 'A5-单条列表')
  assert.equal(single.length, 0, `松散列表不该被判单条，实际 ${single.length} 条`)
})

test('真正的单条列表仍然要被指出', () => {
  const text = ['## 要点', '', '- 只有这一条', '', '下面是一段正常正文，用来切断列表。'].join('\n')
  const a5 = pick(evaluateAll(text), 'A5')
  assert.ok(a5.hits.some(hit => hit.rule === 'A5-单条列表'), '真单条列表应被指出')
})

/* ───────── 能力诚实性：判不了就必须说判不了 ───────── */

test('B4 零命中时判 insufficient，不得印成"未发现问题"', () => {
  // 实测问题：真实报告里「最佳首选」与「P2」互相打架，B4 却给出 0 问题。
  // 规则层只能核对数值口径，文字论证冲突本来就不在能力范围内 —— 那就必须说"没评估"。
  const text = [
    'PartsTech 是最佳首选渠道，优先接洽。',
    '优先级表把 PartsTech 排在 P2，Summit Racing 排在 P1。',
    '挂牌价 573.99 美元，据此判断用户可接受 500—600 美元区间。',
    '首批投入 30 万元，覆盖三个州。',
  ].join('\n')
  const b4 = pick(evaluateAll(text), 'B4')
  assert.equal(b4.state, 'insufficient', `B4 应判"未能评估"，实际 state=${b4.state} severity=${b4.severity}`)
  assert.equal(b4.hits.length, 0)
  assert.match(b4.reason ?? '', /无法由规则判定|未评估|不说明/u)
})

test('B4 抓到真冲突时照常出分（不能为了诚实把能力也关掉）', () => {
  const text = [
    '项目预算：120 万元。',
    '第二阶段另有一笔调整，项目预算：180 万元。',
    '交付周期为 4 个月，验收后结算。',
  ].join('\n')
  const b4 = pick(evaluateAll(text), 'B4')
  assert.equal(b4.state, 'scored')
  assert.ok(b4.hits.length > 0, '应命中数值冲突')
})

test('B5 写了风险词但无法判断风险是否改变方案时，判 insufficient', () => {
  // 实测问题：只要全文出现过一次"风险"，B5 就给 0 问题，于是"写了风险却没改方案"完全漏检。
  const text = [
    '本项目存在合规风险，需注意数据出境。',
    '首轮先进入 PartsTech，其余渠道暂缓。',
    '需要投入 30 万元用于首批内容制作。',
  ].join('\n')
  const b5 = pick(evaluateAll(text), 'B5')
  assert.equal(b5.state, 'insufficient', `B5 应判"未能评估"，实际 state=${b5.state} severity=${b5.severity}`)
})

test('B5 全文零代价表述时仍照常扣分（这是确定判定得出的缺陷）', () => {
  const text = [
    '首轮先进入 PartsTech 平台。',
    '次轮进入 Summit Racing，再进入亚马逊。',
    '由渠道组负责推进，两个月内完成。',
  ].join('\n')
  const b5 = pick(evaluateAll(text), 'B5')
  assert.equal(b5.state, 'scored')
  assert.ok(b5.severity >= 1, `没有任何代价表述应扣分，实际 severity=${b5.severity}`)
})

/* ───────── 结构误报第二组（真机跑出来的，不是想出来的）───────── */

test('标题不被当成"无事实锚点"的论证句抽样', () => {
  // 实测问题：一份 291 字的方案，B2 的 4 条命中里有 3 条是标题。
  // 标题没有数字天经地义 —— 它是指路牌，不是论点。
  const text = [
    '## 一、市场认知',
    '',
    '这项工作对团队能力提升有重要作用，需要长期投入与持续关注。',
    '',
    '## 二、渠道现状',
    '',
    '目前没有可用的准入路径，也没有已确认的联系窗口。',
    '',
    '## 三、价格判断',
    '',
    '价格区间是否合理，还需要更多一线反馈来判断。',
    '',
    '## 四、风险',
    '',
    '存在若干外部不确定性，需要在推进过程中逐步确认。',
    '',
    '## 五、结论',
    '',
    '建议先做小范围验证，再决定是否扩大投入范围。',
  ].join('\n')
  const b2 = pick(evaluateAll(text), 'B2')
  for (const hit of b2.hits.filter(item => item.rule === 'B2-无事实锚点')) {
    assert.ok(!/^#{1,6}\s/u.test(hit.snippet.trim()), `标题被当成论证句抽样了：${hit.snippet}`)
  }
})

test('表格行不会挤掉正文里的决断句', () => {
  // 实测问题：摘要保住了「| PartsTech | P2 |」，却丢掉了
  // 「PartsTech 是最佳首选渠道，应优先接洽。」—— 保碎片、丢结论，比压缩比难看严重得多。
  const text = [
    '# 渠道方案',
    'PartsTech 是最佳首选渠道，应优先接洽。',
    '| 渠道 | 优先级 |',
    '|---|---|',
    '| Summit Racing | P1 |',
    '| PartsTech | P2 |',
    '风险与代价需要在下一轮评估中说明。',
  ].join('\n')
  const result = distill(text, { level: 'summary' })
  const kept = JSON.stringify(result.elements)
  assert.ok(
    !kept.includes('| PartsTech | P2 |') || kept.includes('PartsTech 是最佳首选渠道'),
    '摘要保住了表格碎片却丢掉了决断句',
  )
  // 0.2.2 的教训：修好"标题被当论证句"之后，标题又能进「观点」了
  // （`## 二、渠道优先级` 因含"优先"被当成决策主张）。这是同一个错的两个出口。
  // 所以这里锁死：结构元素不得出现在任何语义池里。
  for (const pool of ['claims', 'stance', 'actions']) {
    const items = result.elements[pool]?.items ?? []
    for (const item of items) {
      assert.ok(
        !/^#{1,6}\s/u.test(item.text.trim()) && !/^\|/u.test(item.text.trim()),
        `结构元素混进了「${pool}」：${item.text}`,
      )
    }
  }
})

test('汉字写的数量同样进硬保护项（只认数字会让中文文档整体失明）', () => {
  assert.ok(hardProtection('全面铺开，第五个月进入规模推广。').includes('number'), '「第五个月」应被保护')
  assert.ok(hardProtection('两个月内完成首轮验证。').includes('number'), '「两个月」应被保护')
  assert.deepEqual(hardProtection('涉及三个部门。'), [], '孤立汉字数字不该被保护（全保护 = 不保护）')
})
