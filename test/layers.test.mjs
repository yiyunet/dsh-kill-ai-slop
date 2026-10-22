/**
 * 四层十二格 —— 算术与闸门的单测。
 *
 * 这些用例只测**可争论之外**的东西：公式、分母、闸门、映射。
 * 判断本身（某一格该给 2 还是 3）不在这里测 —— 那是人的活，测不了。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ATTRIBUTIONS,
  CELLS,
  CELL_ORDER,
  CONDITIONS,
  DIMENSION_HINTS,
  LAYERS,
  LAYER_ORDER,
  SCORE_ANCHORS,
  auditDeductions,
  compositeOf,
  emptyCells,
  evaluateLayers,
  hintCells,
  normalizeCell,
  normalizeCells,
  readinessOf,
  scoreAllLayers,
  scoreLayer,
  validateDeduction,
  whyUnscored,
} from '../plugin-src/host/layers.mjs'
import { audit, renderLayersMarkdown } from '../plugin-src/host/audit.mjs'

/**
 * ★ 0.7.8：单格分从 0–4 改成 0–10（0.5 一档）。
 *   旧用例仍按 0–4 的语义写（4=满分、3=局部补充…），这里统一 ×2.5 换算 ——
 *   所以断言里的百分比（75 / 83.3 / 100 …）一个都不用改。
 */
const scale = value => value * 2.5

const rated = (id, score, extra = {}) => ({ id, state: 'rated', score: scale(score), attribution: 'submitter', ...extra })

/** 一组「全部及格」的格子，供各用例复用。 */
const allThrees = () => CELL_ORDER.map(id => rated(id, 3))

/** 把若干格改成指定分（0–4 语义），其余保持 3。 */
const withScores = (overrides) => CELL_ORDER.map(id => rated(id, overrides[id] ?? 3))

/**
 * 一份「能通过校验」的评审记录。
 *
 * ★ 0.7.0 起分数只能来自 review：必须有理解摘要，每格必须有能在原文逐字找到的引文。
 *   下面两句引文都取自 DOC（第 3 行、第 7 行）。
 */
const REVIEW_CONCLUSION = { quote: '结论：先做汽修垂直平台。', line: 3 }
const REVIEW_ACTION = { quote: '第 1 周搜集名录。', line: 7 }
const FULL_DEDUCTION = { C1: '本轮就要定', C2: '提交者职责', C3: '全文未写', C4: '卡住首个动作' }

const makeReview = (overrides = {}) => ({
  scoreScale: 10,
  basis: 'task',
  understanding: {
    claims: [{ text: '主张先做汽修垂直平台', quote: [REVIEW_CONCLUSION] }],
    done: [{ text: '给了第一周的动作', quote: [REVIEW_ACTION] }],
    open: [],
  },
  cells: CELL_ORDER.map(id => ({
    id,
    state: 'rated',
    score: scale(3),
    attribution: 'submitter',
    claimBasis: '明示',
    note: '测试用判定',
    evidence: [REVIEW_ACTION],
    deduction: FULL_DEDUCTION,
  })),
  ...overrides,
})

/* ───────────────────────── 常量形状 ───────────────────────── */

test('权重合计为 1，且四层各三格', () => {
  const total = LAYER_ORDER.reduce((sum, id) => sum + LAYERS[id].weight, 0)
  assert.equal(Math.round(total * 1000) / 1000, 1)
  assert.deepEqual(LAYER_ORDER, ['intent', 'strategy', 'execution', 'expression'])
  for (const id of LAYER_ORDER) assert.equal(LAYERS[id].cells.length, 3, `${id} 应有 3 格`)
})

test('十二格齐全且顺序固定', () => {
  assert.equal(CELL_ORDER.length, 12)
  assert.deepEqual([...CELL_ORDER], ['I1', 'I2', 'I3', 'S1', 'S2', 'S3', 'E1', 'E2', 'E3', 'V1', 'V2', 'V3'])
  for (const id of CELL_ORDER) assert.ok(CELLS[id], `${id} 应有定义`)
})

test('I2 叫「用途对齐」，不是「结果推进」', () => {
  // 改名会让意图层与执行层重复（E1 已在问"产出什么"），并让
  // 「局部有用、整体没接住任务」的材料拿高分 —— 这条被回退过一次，锁住。
  assert.equal(CELLS.I2.label, '用途对齐')
  assert.match(CELLS.I2.question, /当前需要的决策或行动支持/)
})

test('四条件与 0–10 锚点齐全', () => {
  for (const id of ['C1', 'C2', 'C3', 'C4']) assert.ok(CONDITIONS[id], `${id} 应存在`)
  for (const score of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.ok(SCORE_ANCHORS[score], `${score} 分应有锚点`)
  assert.match(SCORE_ANCHORS[10].test, /本阶段必要工作已完成/)
})

/* ───────────────────────── 空白模板 ───────────────────────── */

test('emptyCells 给出十二个未评格，且不带分数', () => {
  const cells = emptyCells()
  assert.equal(cells.length, 12)
  for (const cell of cells) {
    assert.equal(cell.state, 'unrated')
    assert.equal(cell.score, null)
  }
})

/* ───────────────────────── 单格规范化 ───────────────────────── */

test('分数越界或非法时退回未评，不猜分数', () => {
  assert.equal(normalizeCell('I1', { state: 'rated', score: 11 }).state, 'unrated')
  assert.equal(normalizeCell('I1', { state: 'rated', score: -1 }).state, 'unrated')
  assert.equal(normalizeCell('I1', { state: 'rated', score: 'abc' }).state, 'unrated')
  assert.equal(normalizeCell('I1', { state: 'rated' }).state, 'unrated')
})

test('0 分是合法分数（查过了，判 0），不是"没评"', () => {
  const cell = normalizeCell('I1', { state: 'rated', score: 0 })
  assert.equal(cell.state, 'rated')
  assert.equal(cell.score, 0)
})

test('小数分数吸附到最近的半档', () => {
  assert.equal(normalizeCell('I1', { state: 'rated', score: 2.6 }).score, 2.5)
  assert.equal(normalizeCell('I1', { state: 'rated', score: 2.8 }).score, 3)
  assert.equal(normalizeCell('I1', { state: 'rated', score: 7.25 }).score, 7.5)
})

test('超过 10 分判非法（不猜一个分数出来）', () => {
  assert.equal(normalizeCell('I1', { state: 'rated', score: 10.5 }).state, 'unrated')
  assert.equal(normalizeCell('I1', { state: 'rated', score: -1 }).state, 'unrated')
})

test('状态两种拼法都认', () => {
  assert.equal(normalizeCell('I1', { state: 'notApplicable' }).state, 'not-applicable')
  assert.equal(normalizeCell('I1', { state: 'not-applicable' }).state, 'not-applicable')
  assert.equal(normalizeCell('I1', { state: 'undetermined' }).state, 'undetermined')
})

test('待确认格的归属被强制为 undetermined', () => {
  const cell = normalizeCell('I1', { state: 'undetermined', attribution: 'submitter' })
  assert.equal(cell.attribution, 'undetermined')
})

test('归属缺省为待确认，不默认归提交者', () => {
  const cell = normalizeCell('I1', { state: 'rated', score: 3 })
  assert.equal(cell.attribution, 'undetermined')
})

test('未知的检查点 id 直接抛错（不静默吞掉）', () => {
  assert.throws(() => normalizeCell('X9', {}), /未知的检查点/)
})

test('normalizeCells 接受数组或对象，缺的补未评', () => {
  const fromArray = normalizeCells([rated('I1', 4)])
  assert.equal(fromArray.length, 12)
  assert.equal(fromArray.find(cell => cell.id === 'I1').score, scale(4))
  assert.equal(fromArray.find(cell => cell.id === 'V3').state, 'unrated')

  const fromObject = normalizeCells({ I1: { state: 'rated', score: 2 } })
  assert.equal(fromObject.find(cell => cell.id === 'I1').score, 2)
})

/* ───────────────────────── 层分 ───────────────────────── */

test('层分 = 本层最弱的一格 ÷ 10 × 100（不是平均）', () => {
  const cells = withScores({ I1: 4, I2: 2, I3: 4 })
  const layer = scoreLayer(cells, 'intent')
  // 最弱格 2 → 50；平均会是 (4+2+4)/3 = 3.333 → 83.3，那正是"问题被盖住"的来源。
  assert.equal(layer.value, 50)
  assert.equal(layer.display, 50)
  assert.equal(layer.mean, 83.3)
  assert.deepEqual(layer.weakest, ['I2'])
  assert.equal(layer.rated, 3)
})

test('一格 3 分不能靠两个 4 分被平均掉', () => {
  // 回归：0.7.6 实测 —— V1=3 / V2=4 / V3=4 印出 91.7 分，
  // 读者看到的是一份没什么问题的文件，而 V1 的判定写着"两处口径未统一"。
  const layer = scoreLayer(withScores({ V1: 3, V2: 4, V3: 4 }), 'expression')
  assert.equal(layer.value, 75)
})

test('未评格不进分母（不能把"我没看"当 0 分或满分）', () => {
  const cells = [{ id: 'I1', state: 'rated', score: 10 }, ...emptyCells().filter(cell => cell.layer === 'intent' && cell.id !== 'I1')]
  const layer = scoreLayer(normalizeCells(cells), 'intent')
  assert.equal(layer.rated, 1)
  assert.equal(layer.value, 100)
  assert.deepEqual(layer.unrated, ['I2', 'I3'])
})

test('待确认格不进分母，也不拖低层分', () => {
  const cells = withScores({ I1: 4, I2: 4 })
  const patched = cells.map(cell => (cell.id === 'I3' ? normalizeCell('I3', { state: 'undetermined' }) : cell))
  const layer = scoreLayer(patched, 'intent')
  assert.equal(layer.value, 100)
  assert.deepEqual(layer.pending, ['I3'])
})

test('整层不适用 → 不出层分，且说清是"不适用"不是"没看"', () => {
  const cells = CELL_ORDER.map(id => (CELLS[id].layer === 'expression'
    ? normalizeCell(id, { state: 'notApplicable' })
    : rated(id, 3)))
  const layer = scoreLayer(cells, 'expression')
  assert.equal(layer.withheld, true)
  assert.equal(layer.value, null)
  assert.match(layer.withheldReason, /整层不适用/)
})

test('层内含 ≤5 分格时必须标出关键缺口', () => {
  const layer = scoreLayer(withScores({ S1: 4, S2: 2, S3: 4 }), 'strategy')
  assert.equal(layer.hasCriticalGap, true)
  assert.deepEqual(layer.criticalGapCells, ['S2'])
})

test('全 10 分的层不标关键缺口', () => {
  const layer = scoreLayer(withScores({ V1: 4, V2: 4, V3: 4 }), 'expression')
  assert.equal(layer.hasCriticalGap, false)
})

test('scoreAllLayers 返回四层且顺序固定', () => {
  const layers = scoreAllLayers(allThrees())
  assert.deepEqual(layers.map(layer => layer.id), LAYER_ORDER)
  for (const layer of layers) assert.equal(layer.value, 75) // 3/4×100
})

/* ───────────────────────── 综合分 ───────────────────────── */

test('综合分 = 层分×权重之和', () => {
  const layers = scoreAllLayers(withScores({ I1: 4, I2: 3, I3: 4, S1: 4, S2: 3, S3: 3, E1: 3, E2: 3, E3: 3, V1: 3, V2: 4, V3: 3 }))
  const composite = compositeOf(layers)
  // 每层都有一格 3 → 四层都是 75 → 综合 75。
  // （按平均算是 82 —— 那个数把 5 处缺口摊平了。）
  assert.equal(composite.display, 75)
  assert.equal(composite.withheld, false)
})

test('每一处缺口都算得出"补上能涨多少分"', () => {
  const result = evaluateLayers({
    cells: withScores({
      I1: 4, I2: 4, I3: 4, S1: 4, S2: 4, S3: 4,
      E1: 4, E2: 4, E3: 3, V1: 3, V2: 4, V3: 4,
    }),
  })
  // 两个缺口各在自己的层里是最弱格：表达 75（V1）、执行 75（E3）、策略 100、意图 100
  assert.equal(result.headline.display, 89)
  const byCell = Object.fromEntries(result.impacts.map(item => [item.cell, item]))
  assert.deepEqual(Object.keys(byCell).sort(), ['E3', 'V1'])
  // 权重决定价格：同样的 3 分，在 10% 的表达层里值 2.5 分，在 35% 的执行层里值 8.7 分。
  assert.equal(byCell.V1.delta, 2.5)
  assert.equal(byCell.E3.delta, 8.7)
  assert.equal(byCell.V1.before, 88.8)
})

test('四层同分时披露"权重未产生区分"', () => {
  const composite = compositeOf(scoreAllLayers(allThrees()))
  assert.equal(composite.weightDiscrimination, false)
})

test('层分不同时 weightDiscrimination 为 true', () => {
  const composite = compositeOf(scoreAllLayers(withScores({ I1: 4, I2: 4, I3: 4 })))
  assert.equal(composite.weightDiscrimination, true)
})

test('任何有权重的层未出分 → 综合分不出（不缩分母凑一个数）', () => {
  const layers = scoreAllLayers([rated('I1', 4)]) // 其余全部未评
  const composite = compositeOf(layers)
  assert.equal(composite.withheld, true)
  assert.equal(composite.value, null)
  assert.match(composite.withheldReason, /综合分不出/)
})

test('整层不适用 → 剩余层权重归一，并说明已归一', () => {
  const cells = CELL_ORDER.map(id => (CELLS[id].layer === 'expression'
    ? normalizeCell(id, { state: 'notApplicable' })
    : rated(id, 3)))
  const layers = scoreAllLayers(cells)
  const composite = compositeOf(layers)
  assert.equal(composite.withheld, false)
  assert.equal(composite.normalized, true)
  assert.match(composite.normalizedNote, /权重已归一/)
  // 三层都是 75 → 归一后仍是 75
  assert.equal(composite.display, 75)
})

test('空层不能当成"不适用"（没收到格子 ≠ 文件不涉及）', () => {
  // 回归：0.5.0 初版把"整层不适用"判成 `skipped.length === members.length`，
  // 而只传了 I1 时其余三层的 members 是空的 —— 0 === 0 成立，
  // 于是三层被当成"不适用"、权重归一化掉，综合分照算成 100。
  // 这与"我没看 ≠ 没问题"是同一个错，只是换了个位置。
  const layers = scoreAllLayers([rated('I1', 4)])
  const strategy = layers.find(layer => layer.id === 'strategy')
  assert.equal(strategy.total, 0)
  assert.equal(strategy.withheld, true)
  assert.match(strategy.withheldReason, /没有收到任何格子/)

  const composite = compositeOf(layers)
  assert.equal(composite.normalized, false, '空层不得触发权重归一化')
  assert.equal(composite.withheld, true)
})

test('待确认项不再挡住综合分，但必须披露', () => {
  // ★ 0.7.7 实测打回来的：11/12 格都判完、只差一格引文格式不对，
  //   面板上的综合分就是「—」，读者一个数也拿不到。
  //   而且那两个未定项早已通过 V1/S1/E3 的扣分进了分数 ——
  //   再拿同一件事挡一次，等于同一件事罚两次。
  const composite = compositeOf(scoreAllLayers(allThrees()), { blocksComposite: true, blockReason: '附件是否随文会改变 I2' })
  assert.equal(composite.withheld, false)
  assert.equal(composite.display, 75)
  assert.equal(composite.unresolved, true)
  assert.match(composite.unresolvedNote, /附件/)
})

test('综合分不给区间、不给"若…则"情形', () => {
  const composite = compositeOf(scoreAllLayers(allThrees()))
  assert.equal('range' in composite, false)
  assert.equal('scenarios' in composite, false)
  assert.equal('min' in composite, false)
  assert.equal('max' in composite, false)
})

/* ───────────────────────── 扣分四条件闸 ───────────────────────── */

const fullDeduction = { C1: '第 5 周提交审批前需要', C2: '提交者该准备', C3: '全文未给', C4: '卡住审批判断' }

test('四条件齐备且归属为提交者 → 扣分成立', () => {
  const verdict = validateDeduction(rated('I2', 3, { deduction: fullDeduction }))
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.missing, [])
})

test('缺任一条件 → 不成立，并指出缺哪条', () => {
  for (const id of ['C1', 'C2', 'C3', 'C4']) {
    const partial = { ...fullDeduction }
    delete partial[id]
    const verdict = validateDeduction(rated('I2', 3, { deduction: partial }))
    assert.equal(verdict.ok, false, `缺 ${id} 时不应成立`)
    assert.ok(verdict.missing.includes(id))
  }
})

test('归属待确认 → 不得扣分（也不默认归提交者）', () => {
  const cell = rated('I2', 3, { deduction: fullDeduction, attribution: 'undetermined' })
  const verdict = validateDeduction(cell)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.missing.includes('attribution'))
  assert.match(verdict.reasons.join(), /不得扣分.*不得默认归提交者/)
})

test('归属为他人/审批方 → 不得扣分，应转审批要件或协作事项', () => {
  const cell = rated('I2', 3, { deduction: fullDeduction, attribution: 'other-party' })
  const verdict = validateDeduction(cell)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reasons.join(), /附录|审批要件/)
})

test('auditDeductions 把不过闸的扣分降级为建议（分数保留）', () => {
  const cells = normalizeCells([
    rated('I2', 3, { deduction: fullDeduction }),
    rated('S2', 2, { deduction: { C1: '需要', C2: '需要' } }), // 缺 C3/C4
    rated('V1', 4),
  ])
  const result = auditDeductions(cells)
  assert.equal(result.accepted.length, 1)
  assert.equal(result.accepted[0].cell, 'I2')
  assert.equal(result.downgraded.length, 1)
  assert.equal(result.downgraded[0].cell, 'S2')
  assert.ok(result.downgraded[0].missing.includes('C3'))
  // 分数没有被改掉
  assert.equal(cells.find(cell => cell.id === 'S2').score, scale(2))
})

test('满分的格不参与扣分闸', () => {
  const cells = normalizeCells([rated('I1', 4), rated('I2', 4)])
  assert.equal(auditDeductions(cells).accepted.length, 0)
  assert.equal(auditDeductions(cells).downgraded.length, 0)
})

/* ───────────────────────── 推进结论 ───────────────────────── */

test('无缺口无待确认 → 可以推进', () => {
  const readiness = readinessOf(allThrees())
  assert.equal(readiness.code, 'proceed')
  assert.equal(readiness.text, '可以推进')
})

test('局部缺口 → 补充相关部分', () => {
  const readiness = readinessOf(allThrees(), { gaps: [{ cell: 'E1', affects: 'local', work: '协作方时点' }] })
  assert.equal(readiness.code, 'supplement')
  assert.ok(readiness.mustDo.some(item => item.includes('协作方时点')))
})

test('核心方向要重选 → 重新形成相关方案', () => {
  const readiness = readinessOf(allThrees(), { gaps: [{ cell: 'S1', affects: 'direction', work: '渠道方向需重定' }] })
  assert.equal(readiness.code, 'rework')
})

test('任一格 ≤1 → 也触发重新形成方案', () => {
  const readiness = readinessOf(withScores({ E1: 1 }))
  assert.equal(readiness.code, 'rework')
})

test('待确认不阻塞 → 先推进不受影响的工作，并列出可以继续的部分', () => {
  const readiness = readinessOf(allThrees(), { pending: [{ label: '协议附件' }] })
  assert.equal(readiness.code, 'advance-unaffected')
  assert.ok(readiness.canStartNow.some(item => item.includes('协议附件')))
  assert.deepEqual(readiness.mustWait, [])
})

test('待确认会阻塞 → 列进必须等', () => {
  const readiness = readinessOf(allThrees(), { pending: [{ label: '拿货价审批', blocks: true }] })
  assert.deepEqual(readiness.mustWait, ['拿货价审批'])
})

test('缺口与待确认可以并存（结论不是单选一档）', () => {
  const readiness = readinessOf(allThrees(), {
    gaps: [{ cell: 'E2', affects: 'local', work: '审批期间报价口径' }],
    pending: [{ label: '成本测算是否存在' }],
  })
  assert.equal(readiness.parts.length, 2)
  assert.match(readiness.text, /补充相关部分/)
  assert.match(readiness.text, /先推进不受影响的工作/)
})

test('零评分时推进结论不得为"可以推进"（未判 ≠ 没问题）', () => {
  // 回归：0.5.0 实测 —— 十二格全未评时，"没有缺口、没有待确认"落到最后一个分支，
  // 报告首屏印出「推进结论：可以推进」。这与"我没看 ≠ 没问题"是同一个错，
  // 只是换到了**结论位**，比分数位更危险：读者会直接照它行动。
  const readiness = readinessOf(emptyCells())
  assert.equal(readiness.code, 'unrated')
  assert.match(readiness.text, /未判定/)
  assert.doesNotMatch(readiness.text, /可以推进/u)
})

test('零评分 + 有待确认项 → 仍不给"可以推进"，只列可以继续的部分', () => {
  const readiness = readinessOf(emptyCells(), { pending: [{ label: '协议附件' }] })
  assert.equal(readiness.code, 'unrated')
  assert.ok(readiness.canStartNow.some(item => item.includes('协议附件')))
})

test('推进结论不由最低分换算：低分格只作参考列出', () => {
  const readiness = readinessOf(withScores({ V3: 2 }))
  assert.equal(readiness.code, 'proceed')     // 表达层局部问题不应让整份重做
  assert.deepEqual(readiness.cellsAtOrBelowTwo, ['V3'])
})

/* ───────────────────────── 端到端 ───────────────────────── */

test('evaluateLayers 端到端：四层都有一格 3 → 四层 75，综合 75', () => {
  const result = evaluateLayers({
    cells: [
      rated('I1', 4, { deduction: null }), rated('I2', 3, { deduction: fullDeduction }), rated('I3', 4),
      rated('S1', 4), rated('S2', 3, { deduction: fullDeduction }), rated('S3', 3, { deduction: fullDeduction }),
      rated('E1', 3, { deduction: fullDeduction }), rated('E2', 3, { deduction: fullDeduction }), rated('E3', 3, { deduction: fullDeduction }),
      rated('V1', 3, { deduction: fullDeduction }), rated('V2', 4), rated('V3', 3, { deduction: fullDeduction }),
    ],
    gaps: [{ cell: 'E2', affects: 'local', work: '审批期间报价口径' }],
    pending: [{ label: '协议附件' }],
  })
  assert.deepEqual(result.headline.layerDisplays, { intent: 75, strategy: 75, execution: 75, expression: 75 })
  assert.equal(result.headline.display, 75)
  assert.equal(result.headline.available, true)
  // 四层同分 → 权重本次没产生区分，必须披露（不能让读者以为权重算过了）
  assert.equal(result.composite.weightDiscrimination, false)
  assert.deepEqual(result.composite.layersWithCriticalGap, [])
  assert.equal(result.isEmpty, false)
  // 8 处低于满分（10）的格：I2 / S2 / S3 / E1 / E2 / E3 / V1 / V3
  assert.equal(result.impacts.length, 8)
})

test('evaluateLayers 无任何评分的格 → 明确说"不是 0 分"', () => {
  const result = evaluateLayers({})
  assert.equal(result.isEmpty, true)
  assert.equal(result.headline.available, false)
  assert.equal(result.headline.display, null)
  for (const layer of result.layers) {
    assert.equal(layer.value, null)
    assert.match(layer.withheldReason, /不是 0 分/)
  }
})

test('evaluateLayers 里待确认项标记 blocks：分数照出，另标"未定"', () => {
  const result = evaluateLayers({ cells: allThrees(), pending: [{ label: '附件', blocks: true }] })
  assert.equal(result.composite.withheld, false)
  assert.equal(result.composite.display, 75)
  assert.equal(result.composite.unresolved, true)
})

test('方向标注写死在返回值里，跨版本不可比', () => {
  const result = evaluateLayers({ cells: allThrees() })
  assert.equal(result.direction, 'higher-is-better')
  assert.equal(result.comparableAcrossVersions, false)
  assert.equal(result.weightsCalibrated, false)
})

/* ───────────────────────── 证据线索 ───────────────────────── */

test('0.3.x 维度映射到十二格：只指路，不给分', () => {
  assert.deepEqual(DIMENSION_HINTS.A4, ['V1'])
  assert.deepEqual(DIMENSION_HINTS.B6, ['E1', 'E2'])
  const hints = hintCells([
    { id: 'A4', label: '模糊与夸大', state: 'scored', summary: '2 处', hits: [{}, {}] },
    { id: 'B6', label: '执行完整性', state: 'scored', summary: '3 条无责任人', hits: [{}] },
  ])
  assert.equal(hints.V1.length, 1)
  assert.equal(hints.V1[0].hits, 2)
  assert.equal(hints.E1[0].from, 'B6')
  assert.equal(hints.I1.length, 0)
})

test('whyUnscored 对四种状态都给得出话', () => {
  assert.match(whyUnscored(normalizeCell('I1', {})), /未评/)
  assert.match(whyUnscored(normalizeCell('I1', { state: 'undetermined' })), /待确认/)
  assert.match(whyUnscored(normalizeCell('I1', { state: 'notApplicable' })), /不适用/)
  assert.equal(whyUnscored(normalizeCell('I1', { state: 'rated', score: 3 })), '')
})

test('归属枚举完整', () => {
  assert.deepEqual(Object.keys(ATTRIBUTIONS), ['submitter', 'other-party', 'undetermined'])
})

/* ───────────────────── 与 audit 报告接线 ───────────────────── */

const DOC = Buffer.from('# 渠道方案\n\n结论：先做汽修垂直平台。\n\n## 一、动作\n\n第 1 周搜集名录。\n', 'utf8')

test('audit 不传 review 时不出分，且不得把报告写成使用说明书（0.7.1）', () => {
  const report = audit({ buffer: DOC, filename: '方案.md', docType: 'proposal' })
  assert.ok(report.layers, 'report.layers 缺失')
  assert.equal(report.layers.source, 'none')
  assert.equal(report.layers.review.code, 'review-required')
  assert.equal(report.layers.headline.available, false, '没有评审就不该有层分')
  assert.equal(report.params.cellsProvided, 0)

  assert.match(report.markdown, /## 〇、四层判分/u)
  assert.match(report.markdown, /本轮不出分/u)
  assert.match(report.markdown, /本轮没有判定/u)

  // ★ 这一条是实测打回来的：没有判定时，报告曾把「12 格规程表 / 四层空表 /
  //   十二格未评表 / 扣分闸四条件 / 提交 JSON」全印一遍 —— 变成一本说明书。
  //   规程属于 slop_prepare 的返回值，不进报告。
  assert.doesNotMatch(report.markdown, /4 分长什么样/u)
  assert.doesNotMatch(report.markdown, /怎么提交评审/u)
  assert.doesNotMatch(report.markdown, /四层与算式/u)
  assert.doesNotMatch(report.markdown, /本次是机器评估/u)

  // 0.3.x 旧章节默认不渲染（与四层分方向相反，同屏会被读反）
  assert.doesNotMatch(report.markdown, /## 一、判断/u)
  assert.doesNotMatch(report.markdown, /表达指数/u)
})

test('理解摘要必须排在四层分数之前（验收顺序）', () => {
  const report = audit({ buffer: DOC, filename: '方案.md', docType: 'proposal', review: makeReview() })
  const summaryAt = report.markdown.indexOf('### 全文理解摘要')
  const scoreAt = report.markdown.indexOf('### 四层与算式')
  assert.ok(summaryAt > 0, '缺少理解摘要')
  assert.ok(scoreAt > summaryAt, '理解摘要必须排在做分之前')
})

test('没有理解摘要 → 整份不出分（先述后判）', () => {
  const review = makeReview()
  delete review.understanding
  const report = audit({ buffer: DOC, filename: '方案.md', docType: 'proposal', review })
  assert.equal(report.layers.review.code, 'no-understanding')
  assert.equal(report.layers.headline.available, false)
})

test('引文在原文找不到 → 只退该格，其余格照常出分', () => {
  const review = makeReview()
  review.cells = review.cells.map(cell => (cell.id === 'V1'
    ? { ...cell, evidence: [{ quote: '这句原文里根本没有出现过', line: 3 }] }
    : cell))
  const report = audit({ buffer: DOC, filename: '方案.md', docType: 'proposal', review })
  const byId = Object.fromEntries(report.layers.cells.map(cell => [cell.id, cell]))
  assert.equal(byId.V1.state, 'undetermined')
  assert.match(byId.V1.note, /原文里找不到/u)
  assert.equal(byId.V2.state, 'rated', '其余格不该被连坐')
  assert.match(report.markdown, /判定未通过核对/u)
})

test('扣分依据不成立时撤销判定：不保留低分，也不自动补满分', () => {
  const review = makeReview()
  review.cells = review.cells.map(cell => (cell.id === 'S1'
    ? { ...cell, score: 2, deduction: { C1: '本轮就要定' } }
    : cell))
  const report = audit({ buffer: DOC, filename: '方案.md', docType: 'proposal', review })
  const s1 = report.layers.cells.find(cell => cell.id === 'S1')
  assert.equal(s1.state, 'undetermined')
  assert.equal(s1.score, null, '依据没了，分就没有来源')
  assert.notEqual(s1.score, 10, '不能自动补成满分')
  assert.equal(report.layers.deductions.machine.length, 0, '机器给分那套必须彻底退场')
})

test('原文换版后旧评审被拒（不能把旧判定套到新版本上）', () => {
  const review = makeReview({ docId: 'sha256:0000000000000000' })
  const report = audit({ buffer: DOC, filename: '方案.md', docType: 'proposal', review })
  assert.equal(report.layers.review.code, 'stale-review')
  assert.equal(report.layers.headline.available, false)
})

test('auditDeductions 不再有机器通道：任何低分都要过闸', () => {
  const cells = normalizeCells(makeReview().cells)
  const result = auditDeductions(cells)
  assert.equal(result.machine.length, 0, '机器给分那套必须彻底退场')
  // 全 3 分且带齐四条件 → 全部过闸，没有"未过闸"的
  assert.equal(result.accepted.length, 12)
  assert.equal(result.downgraded.length, 0)
})

test('audit 传 cells 后出层分与综合分，且说明四条件闸', () => {
  const report = audit({
    buffer: DOC,
    filename: '方案.md',
    docType: 'proposal',
    review: makeReview(),
  })
  assert.equal(report.layers.headline.available, true)
  assert.deepEqual(report.layers.headline.layerDisplays, { intent: 75, strategy: 75, execution: 75, expression: 75 })
  assert.equal(report.layers.headline.display, 75)
  assert.equal(report.params.reviewProvided, 1)
  assert.equal(report.params.reviewCode, 'ok')
  assert.match(report.markdown, /扣分闸：四条件同时成立/u)
  assert.match(report.markdown, /决定权不在提交者/u)
  // 四层同分必须披露权重未产生区分
  assert.match(report.markdown, /未产生区分/u)
})

test('audit 里待确认项 blocks 时分数照出，未定项单独列出', () => {
  const report = audit({
    buffer: DOC,
    filename: '方案.md',
    docType: 'proposal',
    review: makeReview(),
    pending: [{ label: '协议附件是否随文', blocks: true }],
  })
  assert.equal(report.layers.composite.withheld, false)
  assert.equal(report.layers.headline.available, true)
  assert.equal(report.layers.composite.unresolved, true)
  assert.match(report.markdown, /待确认/u)
  // 分数照出，但绝不冒充区间：不出现"若…则 X 分"那类编出来的数
  assert.doesNotMatch(report.markdown, /77[–-]80/u)
})

test('章节编号不得跳号：无台账时复现信息是「九」，有台账时是「十」', () => {
  // 回归：0.5.0 实测 —— 台账那节是条件渲染，编号却是字面量，
  // 于是没有台账时编号从"八"直接跳到"十"，读者以为漏了一整节。
  const withoutLedger = audit({ buffer: DOC, filename: '方案.md', docType: 'proposal', legacySections: true })
  assert.doesNotMatch(withoutLedger.markdown, /## 十、复现信息/u)
  assert.match(withoutLedger.markdown, /## 九、复现信息/u)

  const withLedger = audit({
    buffer: DOC,
    filename: '方案.md',
    docType: 'proposal',
    legacySections: true,
    task: '出一个落地方案',
    obligations: [{ id: 'O1', question: '首轮做哪个渠道？', origin: 'explicit', coverage: 'missing' }],
  })
  assert.match(withLedger.markdown, /## 九、交付承接台账/u)
  assert.match(withLedger.markdown, /## 十、复现信息/u)
})

test('旧三指数与四层分不得同屏混读：两行都要标方向', () => {
  const report = audit({ buffer: DOC, filename: '方案.md', docType: 'proposal', legacySections: true })
  // §〇 四层分：越高越好
  assert.match(report.markdown, /越高越好/u)
  // §一 三指数：越高越差，且必须点明不是四层质量分
  assert.match(report.markdown, /越高越差/u)
  assert.match(report.markdown, /不是四层质量分/u)
})

test('renderLayersMarkdown 单独可渲染（面板与报告共用同一份）', () => {
  const result = evaluateLayers({ cells: CELL_ORDER.map(id => rated(id, 4)) })
  const markdown = renderLayersMarkdown({ ...result, hints: {}, weightsNote: '测试用' })
  assert.ok(Array.isArray(markdown))
  assert.match(markdown.join('\n'), /综合质量分 100/u)
})

test('报告 §〇 的四层顺序 = 表达 → 策略 → 执行 → 意图（与面板同一份）', () => {
  // 曾经：面板按 表达→策略→执行→意图，报告按模型顺序 意图→策略→执行→表达。
  // 同一份结果两个排法。现在顺序的真源在 layers.mjs 的 DISPLAY_ORDER，三处读它。
  const report = audit({
    buffer: DOC,
    filename: '方案.md',
    docType: 'proposal',
    review: makeReview(),
  })

  // 首屏四层横排（全角空格分隔）
  assert.match(report.markdown, /\*\*表达 75　策略 75　执行 75　意图 75\*\*/u)

  // 四层表的行序
  const layerRows = report.markdown.split('\n')
    .filter(line => /^\| \*\*(?:表达|策略|执行|意图)\*\* \|/u.test(line))
    .map(line => /^\| \*\*(.+?)\*\*/u.exec(line)[1])
  assert.deepEqual(layerRows, ['表达', '策略', '执行', '意图'])

  // 十二格表的行序：V1 在最前，I1 在最后
  // ★ 只看「扣分闸」之前：后面「每一处缺口值多少分」也是 | **V1** | 这种行写法，
  //   不切开就会把两张表的 24 行一起捞进来（0.7.8 实测踩到）。
  const beforeGate = report.markdown.split('### 扣分闸')[0]
  const cellRows = beforeGate.split('\n')
    .filter(line => /^\| \*\*[VSEI]\d\*\* \|/u.test(line))
    .map(line => /\*\*([VSEI]\d)\*\*/u.exec(line)[1])
  assert.deepEqual(cellRows, ['V1', 'V2', 'V3', 'S1', 'S2', 'S3', 'E1', 'E2', 'E3', 'I1', 'I2', 'I3'])
})
