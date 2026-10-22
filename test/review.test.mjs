/**
 * 评审记录校验器 —— 只测**可争论之外**的东西。
 *
 * 这里测的不是"某格该给 2 还是 3"（那是通读者的活，测不了），
 * 而是四条机器能确定的事：引文在不在原文、状态自不自洽、原文有没有换版、算术对不对。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { docIdOf, verifyReview } from '../plugin-src/host/review.mjs'

const DOC = ['# 方案', '', '结论：先做汽修垂直平台。', '', '## 一、动作', '', '第 1 周搜集名录。', ''].join('\n')

const ACTION = { quote: '第 1 周搜集名录。', line: 7 }
const CONCLUSION = { quote: '结论：先做汽修垂直平台。', line: 3 }
const FULL_DEDUCTION = { C1: '本轮就要定', C2: '提交者职责', C3: '全文未写', C4: '卡住首个动作' }

const baseReview = (overrides = {}) => ({
  scoreScale: 10,
  basis: 'task',
  docId: docIdOf(DOC),
  understanding: {
    claims: [{ text: '主张先做汽修垂直平台', quote: [CONCLUSION] }],
    done: [{ text: '给了第一周动作', quote: [ACTION] }],
    open: [],
  },
  cells: [{ id: 'V1', state: 'rated', score: 10, claimBasis: '明示', note: '未发现矛盾', evidence: [ACTION] }],
  ...overrides,
})

const cellOf = (result, id) => result.cells.find(cell => cell.id === id)

test('刻度不符整份作废（旧 0–4 刻度评审不能被当成 0–10 读）', () => {
  // docId 只能证明"评的是这一版原文"，证明不了"用的是哪一把尺"。
  // 一份 3 分（=3/4）的旧评审在新刻度下会被读成 3/10，整份文件凭空掉 55 分且不报错。
  const review = baseReview()
  delete review.scoreScale
  assert.equal(verifyReview({ review, docText: DOC }).code, 'scale-mismatch')
  assert.equal(verifyReview({ review: { ...baseReview(), scoreScale: 4 }, docText: DOC }).code, 'scale-mismatch')
  assert.equal(verifyReview({ review: baseReview(), docText: DOC }).code, 'ok')
})

test('docId 对空白与换行差异不敏感，对内容变化敏感', () => {
  assert.equal(docIdOf('a\r\nb \n'), docIdOf('a\nb'))
  assert.notEqual(docIdOf('a\nb'), docIdOf('a\nc'))
})

test('没有 review 就不出分（引擎不代判）', () => {
  const result = verifyReview({ review: null, docText: DOC })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'review-required')
  assert.equal(result.cells.filter(cell => cell.state === 'rated').length, 0)
})

test('没带 docId 只提醒，不阻断', () => {
  const review = baseReview()
  delete review.docId
  const result = verifyReview({ review, docText: DOC })
  assert.equal(result.code, 'ok')
  assert.ok(result.warnings.some(item => item.kind === 'no-docid'))
})

test('原文换版后旧评审被拒（不能套用到新版本）', () => {
  const review = baseReview({ docId: 'sha256:0000000000000000' })
  const result = verifyReview({ review, docText: DOC })
  assert.equal(result.code, 'stale-review')
  assert.equal(result.docId.match, false)
  assert.equal(result.cells.filter(cell => cell.state === 'rated').length, 0)
})

test('没有理解摘要 → 先述后判，整份不出分', () => {
  const review = baseReview({ understanding: { claims: [], done: [], open: [] } })
  const result = verifyReview({ review, docText: DOC })
  assert.equal(result.code, 'no-understanding')
  assert.equal(result.cells.filter(cell => cell.state === 'rated').length, 0)
})

test('理解摘要里对不上原文的那条被丢掉，不采信', () => {
  const review = baseReview()
  review.understanding.claims.push({ text: '作者承诺了交付日期', quote: [{ quote: '这句原文里没有', line: 3 }] })
  const result = verifyReview({ review, docText: DOC })
  assert.equal(result.understanding.claims.length, 1)
  assert.ok(result.warnings.some(item => item.kind === 'understanding-dropped'))
})

test('引文查无此句 → 该格退回待确认，不保留分数', () => {
  const review = baseReview()
  review.cells = [{ id: 'V1', state: 'rated', score: 2, note: '有矛盾', evidence: [{ quote: '原文里没有这句', line: 3 }], deduction: FULL_DEDUCTION }]
  const result = verifyReview({ review, docText: DOC })
  const cell = cellOf(result, 'V1')
  assert.equal(cell.state, 'undetermined')
  assert.equal(cell.score, null)
  assert.ok(result.rejects.some(item => item.cell === 'V1' && item.kind === 'quote-not-found'))
})

test('引文存在但行号偏了 → 采信并回填真实行号，不退回（0.7.3）', () => {
  // 实测踩过：模型报的行号系统性差 1 行，11/12 格被判"依据不成立"，
  // 而它们的引文全都真实存在。行号偏 1 是排版问题，不是造假。
  const review = baseReview()
  review.cells = [{ id: 'V1', state: 'rated', score: 10, note: 'ok', evidence: [{ quote: ACTION.quote, line: 2 }] }]
  const result = verifyReview({ review, docText: DOC })
  const cell = cellOf(result, 'V1')
  assert.equal(cell.state, 'rated', '引文真实存在，不能因为行号偏了就废掉这一格')
  assert.equal(cell.evidence[0].line, 7, '行号按原文实际位置回填')
  assert.ok(result.warnings.some(item => item.kind === 'line-corrected'), '必须留一条提醒，不能悄悄改')
})

test('满分也要正面证据：没有引文一律退回', () => {
  const review = baseReview()
  review.cells = [{ id: 'V1', state: 'rated', score: 10, note: '未发现问题', evidence: [] }]
  const result = verifyReview({ review, docText: DOC })
  assert.equal(cellOf(result, 'V1').state, 'undetermined')
  assert.ok(result.rejects.some(item => item.kind === 'no-evidence'))
})

test('扣分依据不成立 → 撤销判定：既不保留低分，也不自动补满分', () => {
  const review = baseReview()
  review.cells = [{ id: 'S1', state: 'rated', score: 2, attribution: 'submitter', note: '没做选择', evidence: [ACTION], deduction: { C1: '本轮要定' } }]
  const result = verifyReview({ review, docText: DOC })
  const cell = cellOf(result, 'S1')
  assert.equal(cell.state, 'undetermined')
  assert.equal(cell.score, null, '依据没了，分就没有来源')
  assert.notEqual(cell.score, 10, '不能自动补成满分')
  assert.match(cell.note, /该由谁做/u)
  assert.ok(result.rejects.some(item => item.kind === 'deduction-incomplete'))
})

test('四条件齐全的低分照常成立', () => {
  const review = baseReview()
  review.cells = [{ id: 'S1', state: 'rated', score: 2, attribution: 'submitter', note: '没做选择', evidence: [ACTION], deduction: FULL_DEDUCTION }]
  const result = verifyReview({ review, docText: DOC })
  assert.equal(cellOf(result, 'S1').state, 'rated')
  assert.equal(cellOf(result, 'S1').score, 2)
  assert.equal(result.rejects.length, 0)
})

test('归属待确认时不得扣分（不默认归提交者）', () => {
  const review = baseReview()
  review.cells = [{ id: 'S1', state: 'rated', score: 2, note: '没做选择', evidence: [ACTION], deduction: FULL_DEDUCTION }]
  const result = verifyReview({ review, docText: DOC })
  assert.equal(cellOf(result, 'S1').state, 'undetermined', '四条件齐但归属不明，仍然不得扣分')
  assert.ok(result.rejects.some(item => item.kind === 'deduction-incomplete'))
})

test('待确认必须写清待确认什么；不适用必须给理由', () => {
  const review = baseReview()
  review.cells = [
    { id: 'V1', state: 'rated', score: 10, note: 'ok', evidence: [ACTION] },
    { id: 'V2', state: 'undetermined', note: '' },
    { id: 'V3', state: 'not-applicable', note: '' },
  ]
  const result = verifyReview({ review, docText: DOC })
  assert.ok(result.rejects.some(item => item.cell === 'V2' && item.kind === 'pending-without-note'))
  assert.ok(result.rejects.some(item => item.cell === 'V3' && item.kind === 'na-without-reason'))
})

test('同一句原文支撑两格 → 提醒分别证明，但不阻断', () => {
  const review = baseReview()
  review.cells = [
    { id: 'V1', state: 'rated', score: 10, note: 'a', evidence: [ACTION] },
    { id: 'E1', state: 'rated', score: 3, attribution: 'submitter', note: 'b', evidence: [ACTION], deduction: FULL_DEDUCTION },
  ]
  const result = verifyReview({ review, docText: DOC })
  assert.equal(result.code, 'ok')
  assert.ok(result.warnings.some(item => item.kind === 'shared-evidence'))
  assert.equal(result.cells.filter(cell => cell.state === 'rated').length, 2)
})

test('引文全在开头 → 提示可能没通读；但只作提醒', () => {
  const longDoc = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行：这一行的内容并不重要。`).join('\n')
  const review = {
    scoreScale: 10,
    basis: 'none',
    docId: docIdOf(longDoc),
    understanding: { claims: [{ text: '开头给了东西', quote: [{ quote: '第 1 行：这一行的内容并不重要。', line: 1 }] }], done: [], open: [] },
    cells: [{ id: 'V1', state: 'rated', score: 10, note: 'ok', evidence: [{ quote: '第 2 行：这一行的内容并不重要。', line: 2 }] }],
  }
  const result = verifyReview({ review, docText: longDoc })
  assert.equal(result.code, 'ok')
  assert.equal(result.stats.frontLoaded, true)
  assert.ok(result.warnings.some(item => item.kind === 'front-loaded'))
})

test('分段记录有缺口 → 提示未覆盖部分没有依据', () => {
  const review = baseReview({ coverage: [{ from: 1, to: 3 }] })
  const result = verifyReview({ review, docText: DOC })
  assert.ok(result.warnings.some(item => item.kind === 'coverage-gap'))
})

test('未知格 id 被拒，不会静默混进十二格', () => {
  const review = baseReview()
  review.cells.push({ id: 'X9', state: 'rated', score: 10, note: 'ok', evidence: [ACTION] })
  const result = verifyReview({ review, docText: DOC })
  assert.ok(result.rejects.some(item => item.cell === 'X9' && item.kind === 'unknown-cell'))
})

test('没提交的格一律待确认，不会被当成满分', () => {
  const result = verifyReview({ review: baseReview(), docText: DOC })
  const missing = result.cells.filter(cell => cell.id !== 'V1')
  assert.equal(missing.length, 11)
  assert.ok(missing.every(cell => cell.state === 'undetermined'))
})
