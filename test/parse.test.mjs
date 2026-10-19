import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ParseError, decodeText, decodeXmlEntities, extensionOf, openZip, parseFile } from '../plugin-src/host/parse.mjs'
import { makeDocx, makePptx, makeXlsx, storedZip } from './zip-fixture.mjs'

test('extensionOf 取小写扩展名', () => {
  assert.equal(extensionOf('报告.DOCX'), 'docx')
  assert.equal(extensionOf('noext'), '')
})

test('decodeText 认 UTF-8 BOM 与 UTF-16LE BOM', () => {
  assert.deepEqual(decodeText(Buffer.from('\uFEFFhello', 'utf8')).encoding, 'utf-8-bom')
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])
  assert.equal(decodeText(utf16).text, 'hi')
})

test('decodeXmlEntities 解实体与数值引用', () => {
  assert.equal(decodeXmlEntities('a &amp; b &#65; &#x42;'), 'a & b A B')
})

test('openZip 能按中央目录定位条目（自制 stored ZIP）', () => {
  const zip = openZip(storedZip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.txt', data: 'world' }]))
  assert.deepEqual(zip.names().sort(), ['a.txt', 'b/c.txt'])
  assert.equal(zip.read('a.txt').toString('utf8'), 'hello')
  assert.equal(zip.read('missing.txt'), undefined)
})

test('openZip 对非 ZIP 抛可诊断错误', () => {
  assert.throws(() => openZip(Buffer.from('这不是 zip')), error => {
    assert.ok(error instanceof ParseError)
    assert.equal(error.code, 'NOT_ZIP')
    assert.ok(typeof error.hint === 'string' && error.hint.length > 0)
    return true
  })
})

test('parseFile 直读文本，覆盖率 1', () => {
  const result = parseFile({ buffer: Buffer.from('第一段。\n\n第二段。', 'utf8'), filename: 'a.md' })
  assert.equal(result.format, 'md')
  assert.equal(result.coverage, 1)
  assert.equal(result.parseMode, 'exact')
  assert.match(result.text, /第二段/u)
})

test('parseFile 解 .docx 的 w:p / w:t', () => {
  const buffer = makeDocx(['目的：确认 Q4 排期。', '成本 3 万元，由张三负责。'])
  const result = parseFile({ buffer, filename: 'x.docx' })
  assert.equal(result.format, 'docx')
  assert.equal(result.coverage, 1)
  assert.match(result.text, /确认 Q4 排期/u)
  assert.match(result.text, /张三/u)
})

test('parseFile 解 .pptx 的多页幻灯片并保持页序', () => {
  const buffer = makePptx([['第一页要点'], ['第二页要点']])
  const result = parseFile({ buffer, filename: 'x.pptx' })
  assert.equal(result.format, 'pptx')
  assert.match(result.text, /第一页要点/u)
  assert.ok(result.text.indexOf('第一页要点') < result.text.indexOf('第二页要点'))
  assert.ok(result.warnings.some(item => item.includes('备注')))
})

test('parseFile 解 .xlsx 的共享字符串与行', () => {
  const buffer = makeXlsx([['项目', '金额'], ['服务器', '12000']])
  const result = parseFile({ buffer, filename: 'x.xlsx' })
  assert.equal(result.format, 'xlsx')
  assert.match(result.text, /服务器\t12000/u)
  assert.ok(result.warnings.some(item => item.includes('公式')))
})

test('parseFile 对 .doc 给出可执行的下一步而不是泛泛报错', () => {
  assert.throws(() => parseFile({ buffer: Buffer.from('x'), filename: 'old.doc' }), error => {
    assert.equal(error.code, 'UNSUPPORTED_TYPE')
    assert.match(error.hint, /另存为 \.docx/u)
    return true
  })
})

test('parseFile 对未知扩展名列出支持清单', () => {
  assert.throws(() => parseFile({ buffer: Buffer.from('x'), filename: 'a.weird' }), error => {
    assert.equal(error.code, 'UNKNOWN_TYPE')
    assert.match(error.hint, /docx/u)
    return true
  })
})

test('parseFile 拒绝空文件', () => {
  assert.throws(() => parseFile({ buffer: Buffer.alloc(0), filename: 'a.txt' }), error => {
    assert.equal(error.code, 'EMPTY_FILE')
    return true
  })
})

test('parseFile 超长文本被截断且覆盖率下调（截断后的结论不代表全文）', () => {
  const result = parseFile({ buffer: Buffer.from('啊'.repeat(500), 'utf8'), filename: 'a.txt' }, { maxChars: 100 })
  assert.equal(result.truncated, true)
  assert.equal(result.text.length, 100)
  assert.ok(result.coverage < 1)
  assert.ok(result.warnings.some(item => item.includes('截断')))
})

test('parseFile 解 .html 时剥标签保留正文', () => {
  const html = '<html><head><style>a{}</style></head><body><h1>标题</h1><p>正文 3 万元。</p></body></html>'
  const result = parseFile({ buffer: Buffer.from(html, 'utf8'), filename: 'a.html' })
  assert.match(result.text, /标题/u)
  assert.match(result.text, /正文 3 万元/u)
  assert.ok(!result.text.includes('<style>'))
})

test('parseFile 对无内容流的 PDF 抛可诊断错误', () => {
  assert.throws(() => parseFile({ buffer: Buffer.from('%PDF-1.4 nothing here'), filename: 'a.pdf' }), error => {
    assert.equal(error.code, 'PDF_NO_STREAM')
    assert.match(error.hint, /OCR|docx/u)
    return true
  })
})
