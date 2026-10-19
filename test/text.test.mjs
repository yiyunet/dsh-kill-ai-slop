import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  computeStats,
  detectScript,
  findRepetition,
  hardProtection,
  normalizeText,
  protectionProfile,
  quoteRanges,
  splitParagraphs,
  splitSentences,
} from '../plugin-src/host/text.mjs'

test('normalizeText 去 BOM、统一换行、去 NUL', () => {
  assert.equal(normalizeText('\uFEFFa\r\nb\rc\u0000'), 'a\nb\nc')
})

test('splitSentences 的偏移能原样切回原文（偏移准确是证据可回溯的前提）', () => {
  const text = '第一句话。第二句话！第三句话？结束了'
  const sentences = splitSentences(text)
  assert.equal(sentences.length, 4)
  for (const sentence of sentences) {
    assert.equal(text.slice(sentence.start, sentence.end), sentence.text)
  }
  assert.equal(sentences[0].text, '第一句话。')
})

test('splitSentences 不会把小数点和缩写切断', () => {
  const text = '成本下降 3.5%，见 e.g. 表格。'
  const sentences = splitSentences(text)
  assert.equal(sentences.length, 1, `实际：${JSON.stringify(sentences.map(item => item.text))}`)
})

test('splitSentences 把收尾引号留在同一句', () => {
  const text = '他说：「这个不行。」然后走了。'
  const sentences = splitSentences(text)
  assert.equal(sentences[0].text, '他说：「这个不行。」')
})

test('splitParagraphs 以连续非空行为一段', () => {
  const text = '第一段第一行\n第一段第二行\n\n第二段'
  const paragraphs = splitParagraphs(text)
  assert.equal(paragraphs.length, 2)
  assert.equal(paragraphs[0].text, '第一段第一行\n第一段第二行')
  assert.equal(text.slice(paragraphs[1].start, paragraphs[1].end), '第二段')
})

test('detectScript 区分中文为主 / 英文为主', () => {
  assert.equal(detectScript('这是一段中文说明，包含 PDF 术语。'), 'cjk')
  assert.equal(detectScript('This is an English paragraph about widgets.'), 'latin')
  assert.equal(detectScript('12345'), 'none')
})

test('findRepetition 能发现重复的 8 字片段，且首次出现不算重复', () => {
  const unit = '我们把这个问题分成三步来处理'
  const text = `${unit}，先看数据。${unit}，再看结论。`
  const { removedChars, units } = findRepetition(text)
  assert.ok(removedChars >= 8, `重复覆盖字符数应为正，实际 ${removedChars}`)
  assert.ok(units.length > 0)
})

test('findRepetition 对不重复文本返回 0 覆盖', () => {
  const { removedChars } = findRepetition('今天天气晴朗。明天可能下雨。后天再看情况决定是否出门。')
  assert.equal(removedChars, 0)
})

test('quoteRanges 定位引号区间，引号内不计水分', () => {
  const text = '他说「赋能生态」，我们照做。'
  const ranges = quoteRanges(text)
  assert.equal(ranges.length, 1)
  const start = text.indexOf('赋能')
  assert.ok(ranges.some(([begin, end]) => start >= begin && start < end))
})

test('hardProtection 只捞硬保护项（数字有分量 / 日期 / 责任人 / 承诺）', () => {
  assert.deepEqual(hardProtection('成本下降 12%。'), ['number'])
  const dated = hardProtection('截止 2026-11-01 交付。')
  assert.ok(dated.includes('date'))
  assert.ok(dated.includes('commitment'))
  assert.ok(hardProtection('由张三牵头。').includes('owner'))
  // "3 个" 这种无量级小数字不足以强制保留，否则提炼会退化成全文照抄
  assert.deepEqual(hardProtection('涉及三个部门。'), [])
})

test('protectionProfile 覆盖软保护项', () => {
  const flags = protectionProfile('若未通过验收则不得上线。')
  assert.ok(flags.includes('negation'))
  assert.ok(flags.includes('condition'))
})

test('computeStats 统计事实句比例与数值个数', () => {
  const stats = computeStats('成本下降 12%，节省 3 万元。团队很喜欢这个方案。')
  assert.ok(stats.numbers >= 2, `数值个数应 ≥2，实际 ${stats.numbers}`)
  assert.ok(stats.factSentenceRatio > 0)
  assert.ok(stats.sentences >= 2)
})
