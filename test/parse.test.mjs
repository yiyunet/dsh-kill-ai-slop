import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ParseError, decodeText, decodeXmlEntities, diagnoseOle2, extensionOf, openZip, parseFile, sniffFormat,
} from '../plugin-src/host/parse.mjs'
import { makeDocx, makeOdt, makeOle2, makePptx, makeXlsx, storedZip } from './zip-fixture.mjs'

/** 断言抛出的是带有指定 code 的 ParseError，并返回它（便于继续查 hint）。 */
function catchParseError(fn, expectedCode) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof ParseError, `期望 ParseError，实际 ${error?.name}`)
    assert.equal(error.code, expectedCode)
    return error
  }
  assert.fail(`期望抛出 ${expectedCode}，但没有抛错`)
}

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

/* ────────────────────────────── 格式嗅探 ─────────────────────────────── */

test('sniffFormat 按魔数判型，不看扩展名', () => {
  assert.equal(sniffFormat(makeDocx(['x'])).kind, 'zip')
  assert.equal(sniffFormat(makeOle2(['Root Entry', 'WordDocument'])).kind, 'ole2')
  assert.equal(sniffFormat(Buffer.from('%PDF-1.7\n…')).kind, 'pdf')
  assert.equal(sniffFormat(Buffer.from('{\\rtf1\\ansi hello}')).kind, 'rtf')
  assert.equal(sniffFormat(Buffer.from('<!DOCTYPE html><html><body>hi</body></html>')).kind, 'html')
  assert.equal(sniffFormat(Buffer.from('<?xml version="1.0"?><a/>')).kind, 'xml')
  assert.equal(sniffFormat(Buffer.from('第一段。\n第二段。', 'utf8')).kind, 'text')
  assert.equal(sniffFormat(Buffer.alloc(64, 0)).kind, 'unknown')
})

test('sniffFormat 不会把纯中文判成二进制（UTF-8 多字节不能按字节数算）', () => {
  assert.equal(sniffFormat(Buffer.from('第一段。\n第二段。', 'utf8')).kind, 'text')
  assert.equal(sniffFormat(Buffer.from('{"a":1}', 'utf8')).kind, 'text')
})

test('parseFile 对 GBK 编码的中文 .txt 仍能解析（交给 GBK 兜底，而不是判成二进制）', () => {
  // GBK：'报价' = B1 A8 BC DB —— 在 sniffFormat 眼里是非法 UTF-8，但它确实是文本
  const result = parseFile({ buffer: Buffer.from([0xb1, 0xa8, 0xbc, 0xdb]), filename: 'a.txt' })
  assert.notEqual(result.text.trim(), '')
})

test('diagnoseOle2 能区分旧版 .doc 与设了密码的 Office 文件', () => {
  assert.equal(diagnoseOle2(makeOle2(['Root Entry', 'WordDocument', '1Table'])), 'doc')
  assert.equal(diagnoseOle2(makeOle2(['Root Entry', 'Workbook'])), 'xls')
  assert.equal(diagnoseOle2(makeOle2(['Root Entry', 'EncryptionInfo', 'EncryptedPackage'])), 'encrypted-ooxml')
  assert.equal(diagnoseOle2(makeOle2(['Root Entry', 'ObjectPool'])), 'ole2-generic')
})

/* ──────────────────────────────── ZIP ───────────────────────────────── */

test('openZip 能按中央目录定位条目（自制 stored ZIP）', () => {
  const zip = openZip(storedZip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.txt', data: 'world' }]))
  assert.deepEqual(zip.names().sort(), ['a.txt', 'b/c.txt'])
  assert.equal(zip.read('a.txt').toString('utf8'), 'hello')
  assert.equal(zip.read('missing.txt'), undefined)
})

test('openZip 对"短到不可能是 ZIP"的文件说明是没下完，而不是"不是 ZIP"', () => {
  const error = catchParseError(() => openZip(Buffer.from('这不是 zip')), 'ZIP_TRUNCATED')
  assert.match(error.message, /短到不可能是完整的 ZIP/u)
  assert.match(error.hint, /重新下载/u)
})

test('openZip 对"有 PK 头但没有中央目录"的文件判为截断', () => {
  const truncated = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x41)])
  const error = catchParseError(() => openZip(truncated), 'ZIP_TRUNCATED')
  assert.match(error.message, /找不到中央目录/u)
})

/* ─────────────────────────────── Office ─────────────────────────────── */

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

test('parseFile 对"容器完整但一个字都没抽到"的 .docx 给 0 覆盖', () => {
  const buffer = storedZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document><w:body><w:p/></w:body></w:document>' },
  ])
  const result = parseFile({ buffer, filename: 'x.docx' })
  assert.equal(result.coverage, 0)
  assert.ok(result.warnings.some(item => item.includes('文本为空')))
})

test('parseFile 把带宏的 .docm 当 .docx 读（正文结构一致）', () => {
  const buffer = makeDocx(['预算 3 万元。'])
  const result = parseFile({ buffer, filename: 'x.docm' })
  assert.equal(result.format, 'docx')
  assert.match(result.text, /预算 3 万元/u)
  assert.deepEqual(result.warnings.filter(item => item.includes('不符')), [])
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

test('parseFile 解 .odt（OpenDocument 容器）', () => {
  const buffer = makeOdt(['第一段要点。', '第二段要点。'])
  const result = parseFile({ buffer, filename: 'x.odt' })
  assert.equal(result.format, 'odt')
  assert.match(result.text, /第一段要点/u)
  assert.match(result.text, /第二段要点/u)
})

/* ────────────────────── 扩展名与内容不符（真实世界主战场）────────────────── */

test('parseFile 遇到".docx 里其实是 xlsx"时按真实类型读出来', () => {
  const buffer = makeXlsx([['项目', '金额']])
  const result = parseFile({ buffer, filename: 'x.docx' })
  assert.equal(result.format, 'xlsx')
  assert.match(result.text, /项目/u)
  assert.ok(result.warnings.some(item => item.includes('扩展名与内容不符')))
})

test('parseFile 遇到".docx 里其实是网页"时按 HTML 读出来', () => {
  const html = '<html><head><title>评阅表</title></head><body><p>总分 90 分。</p></body></html>'
  const result = parseFile({ buffer: Buffer.from(html, 'utf8'), filename: 'x.docx' })
  assert.equal(result.format, 'html')
  assert.match(result.text, /总分 90 分/u)
  assert.ok(result.warnings.some(item => item.includes('扩展名与内容不符')))
})

test('parseFile 遇到".docx 里其实是旧版 .doc"时说清是旧格式并给出另存为路径', () => {
  const buffer = makeOle2(['Root Entry', 'WordDocument', '1Table', 'SummaryInformation'])
  const error = catchParseError(() => parseFile({ buffer, filename: 'x.docx' }), 'LEGACY_OFFICE')
  assert.match(error.message, /旧版 Office 二进制/u)
  assert.match(error.hint, /另存为/u)
  assert.match(error.hint, /\.docx/u)
})

test('parseFile 遇到"设了打开密码的 .docx"时指向解除密码，而不是另存为', () => {
  const buffer = makeOle2(['Root Entry', 'EncryptionInfo', 'EncryptedPackage'])
  const error = catchParseError(() => parseFile({ buffer, filename: 'x.docx' }), 'ENCRYPTED_OFFICE')
  assert.match(error.message, /打开密码/u)
  assert.match(error.hint, /密码/u)
})

test('parseFile 对网页系统导出的 ".doc"（内容其实是 HTML）照样能读', () => {
  const html = '<html><body><table><tr><td>评分</td><td>88</td></tr></table></body></html>'
  const result = parseFile({ buffer: Buffer.from(html, 'utf8'), filename: 'old.doc' })
  assert.equal(result.format, 'html')
  assert.match(result.text, /88/u)
  assert.ok(result.warnings.some(item => item.includes('扩展名与内容不符')))
})

test('parseFile 对纯文本伪装成 .docx 的文件照样能读', () => {
  const result = parseFile({ buffer: Buffer.from('一、目的\n二、要求', 'utf8'), filename: 'x.docx' })
  assert.match(result.text, /二、要求/u)
  assert.ok(result.warnings.some(item => item.includes('扩展名与内容不符')))
})

/* ────────────────────────── 拒绝路径也说清原因 ────────────────────────── */

test('parseFile 仍不展开压缩包（防压缩炸弹）', () => {
  const buffer = storedZip([{ name: 'a.txt', data: 'x' }])
  const error = catchParseError(() => parseFile({ buffer, filename: 'a.zip' }), 'UNSUPPORTED_TYPE')
  assert.match(error.hint, /压缩包/u)
})

test('parseFile 对未知二进制给出头部字节，便于回贴诊断', () => {
  const buffer = Buffer.alloc(64, 0)
  const error = catchParseError(() => parseFile({ buffer, filename: 'a.bin' }), 'UNKNOWN_CONTENT')
  assert.match(error.message, /00 00 00 00/u)
  assert.match(error.hint, /docx/u)
})

test('parseFile 拒绝空文件', () => {
  catchParseError(() => parseFile({ buffer: Buffer.alloc(0), filename: 'a.txt' }), 'EMPTY_FILE')
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
  const error = catchParseError(
    () => parseFile({ buffer: Buffer.from('%PDF-1.4 nothing here'), filename: 'a.pdf' }),
    'PDF_NO_STREAM',
  )
  assert.match(error.hint, /OCR|docx/u)
})
