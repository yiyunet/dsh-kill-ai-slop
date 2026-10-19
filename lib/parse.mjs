// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/parse.mjs
/**
 * 文件解析层 —— 把"用户收到的文件"变成可分析的规范文本。
 *
 * ★ 零依赖：不引入 mammoth / pdf-parse / xlsx。
 *   理由：这三个包各有体积、传递依赖与清洗缺口（mammoth 明确不做 sanitisation），
 *   而我们只需要**纯文本**，不需要保留样式、图片、公式。自己解 ZIP + 解 XML 文本节点，
 *   攻击面反而更小：不执行任何文件内嵌内容，不解析样式，不落盘。
 *
 * ★ 一切结论都要带 **coverage（解析覆盖率）**：
 *   "没解析出来"和"没有内容"必须能被区分。覆盖率不足时下游不给总分。
 *
 * 支持矩阵（初版实现，逐项由 test/parse.test.mjs 覆盖）：
 *   .txt/.md/.csv/.json/.log/.yaml/.html  直读（UTF-8 / UTF-16 BOM / GBK 兜底）
 *   .docx                                 ZIP → word/document.xml → w:p / w:t
 *   .pptx                                 ZIP → ppt/slides/slideN.xml → a:p / a:t
 *   .xlsx                                 ZIP → xl/sharedStrings.xml + xl/worksheets/sheetN.xml
 *   .pdf                                  内容流 inflate → BT/ET 文本算子（启发式，会明示）
 *   .doc/.xls/.ppt（旧二进制）、图片、压缩包   → 明确不支持，给出可执行的下一步
 */

import { inflateRawSync, inflateSync } from 'node:zlib'

import { normalizeText } from './text.mjs'

/** 直读文本类扩展名。 */
const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'log', 'ini', 'conf', 'xml', 'html', 'htm', 'rtf', 'srt', 'vtt', 'sql', 'js', 'mjs', 'ts', 'py',
])
/** 明确不支持、且要给出理由的扩展名。 */
const UNSUPPORTED_REASON = {
  doc: '旧版 Word 二进制（.doc）。请在 Word/WPS 里另存为 .docx 后再分析。',
  xls: '旧版 Excel 二进制（.xls）。请另存为 .xlsx 或导出 .csv 后再分析。',
  ppt: '旧版 PowerPoint 二进制（.ppt）。请另存为 .pptx 后再分析。',
  pages: 'Apple Pages 文稿。请导出为 .docx 或 .pdf 后再分析。',
  key: 'Apple Keynote 文稿。请导出为 .pptx 或 .pdf 后再分析。',
  numbers: 'Apple Numbers 表格。请导出为 .xlsx 或 .csv 后再分析。',
  zip: '压缩包不展开分析（防止压缩炸弹）。请解压后逐个文件分析。',
  rar: '压缩包不展开分析。请解压后逐个文件分析。',
  '7z': '压缩包不展开分析。请解压后逐个文件分析。',
  png: '图片不含可分析文本（本插件不做 OCR）。',
  jpg: '图片不含可分析文本（本插件不做 OCR）。',
  jpeg: '图片不含可分析文本（本插件不做 OCR）。',
  gif: '图片不含可分析文本（本插件不做 OCR）。',
  webp: '图片不含可分析文本（本插件不做 OCR）。',
  eml: '邮件原文（.eml）暂未支持。请把正文复制为 .txt 后再分析。',
  msg: 'Outlook 邮件（.msg）暂未支持。请把正文复制为 .txt 后再分析。',
}

/** 取小写扩展名（不含点）。 */
export function extensionOf(filename) {
  const name = String(filename ?? '')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** 解析失败时抛出，携带可执行的下一步。 */
export class ParseError extends Error {
  constructor(code, message, { hint, stage } = {}) {
    super(message)
    this.name = 'ParseError'
    this.code = code
    this.hint = hint
    this.stage = stage
  }

  toDiagnostic() {
    return { code: this.code, message: this.message, hint: this.hint, stage: this.stage }
  }
}

/* ────────────────────────────── 文本解码 ─────────────────────────────── */

/**
 * 字节 → 字符串。顺序：BOM 优先 → UTF-8 → GBK 兜底（Node 带 ICU 时可用）。
 * 判断依据是**替换字符比例**，不是"猜编码"——用证据决定，不靠运气。
 */
export function decodeText(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom' }
  }

  const utf8 = new TextDecoder('utf-8').decode(bytes)
  const lossRatio = (utf8.match(/\uFFFD/gu) ?? []).length / Math.max(1, utf8.length)
  if (lossRatio <= 0.002) return { text: utf8, encoding: 'utf-8' }

  // GBK 兜底：中文办公文档里极常见。Node 未带 ICU 时构造会抛错 —— 那就老实放弃。
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes)
    const gbkLoss = (gbk.match(/\uFFFD/gu) ?? []).length / Math.max(1, gbk.length)
    if (gbkLoss < lossRatio) return { text: gbk, encoding: 'gbk' }
  } catch {
    /* 无 ICU 支持，保持 utf-8 结果 */
  }
  return { text: utf8, encoding: 'utf-8-lossy' }
}

/* ─────────────────────────────── ZIP ────────────────────────────────── */

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * 最小 ZIP 读取器：只读中央目录 + 按需解压单个条目。
 * 不支持 ZIP64、不支持加密条目 —— 遇到就跳过并记警告（不静默）。
 */
export function openZip(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])

  let eocd = -1
  const scanFloor = Math.max(0, bytes.length - 66000)
  for (let at = bytes.length - 22; at >= scanFloor; at -= 1) {
    if (bytes.readUInt32LE(at) === EOCD_SIG) {
      eocd = at
      break
    }
  }
  if (eocd < 0) {
    throw new ParseError('NOT_ZIP', '这不是一个可识别的 ZIP 容器（未找到中央目录）。', {
      hint: '若文件其实是旧版 .doc/.xls/.ppt，请先另存为新格式；若已损坏，请重新导出。',
      stage: 'zip',
    })
  }

  const entryCount = bytes.readUInt16LE(eocd + 10)
  const cdOffset = bytes.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff) {
    throw new ParseError('ZIP64_UNSUPPORTED', '该文件是 ZIP64 容器，暂不支持。', {
      hint: '这通常是超大或加密导出的 Office 文件；请拆小或换用 .pdf 导出。',
      stage: 'zip',
    })
  }

  const entries = new Map()
  let cursor = cdOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CD_SIG) break
    const method = bytes.readUInt16LE(cursor + 10)
    const compSize = bytes.readUInt32LE(cursor + 20)
    const uncompSize = bytes.readUInt32LE(cursor + 24)
    const nameLen = bytes.readUInt16LE(cursor + 28)
    const extraLen = bytes.readUInt16LE(cursor + 30)
    const commentLen = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    entries.set(name, { name, method, compSize, uncompSize, localOffset })
    cursor += 46 + nameLen + extraLen + commentLen
  }

  /** 解压单个条目 → Buffer（不存在返回 undefined）。 */
  function read(name) {
    const entry = entries.get(name)
    if (entry === undefined) return undefined
    const local = entry.localOffset
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL_SIG) {
      throw new ParseError('ZIP_BAD_LOCAL_HEADER', `ZIP 条目头损坏：${name}`, { stage: 'zip' })
    }
    const nameLen = bytes.readUInt16LE(local + 26)
    const extraLen = bytes.readUInt16LE(local + 28)
    const dataStart = local + 30 + nameLen + extraLen
    const data = bytes.subarray(dataStart, dataStart + entry.compSize)
    if (entry.method === 0) return data
    if (entry.method === 8) {
      try {
        return inflateRawSync(data)
      } catch (cause) {
        throw new ParseError('ZIP_INFLATE_FAILED', `ZIP 条目解压失败：${name}（${cause.message}）`, { stage: 'zip' })
      }
    }
    throw new ParseError('ZIP_METHOD_UNSUPPORTED', `ZIP 条目使用了不支持的压缩方式 ${entry.method}：${name}`, {
      hint: '这是加密或特殊压缩导出的 Office 文件；请在办公软件里重新导出。',
      stage: 'zip',
    })
  }

  return { entries, read, names: () => [...entries.keys()] }
}

/* ─────────────────────────────── XML ────────────────────────────────── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** 解 XML 实体 + 数值引用。 */
export function decodeXmlEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** 抽出某个标签内的全部文本（按出现顺序），可选段落分隔。 */
function collectTagText(xml, { paragraphTag, textTag, breaks = [] }) {
  const source = String(xml ?? '')
  const paragraphs = []
  const paragraphPattern = new RegExp(`<${paragraphTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${paragraphTag}>|<${paragraphTag}(?:\\s[^>]*)?/>`, 'gu')
  for (const match of source.matchAll(paragraphPattern)) {
    let body = match[1] ?? ''
    if (body === '') {
      paragraphs.push('')
      continue
    }
    for (const breakTag of breaks) {
      body = body.replace(new RegExp(`<${breakTag}(?:\\s[^>]*)?/>`, 'gu'), '\n')
    }
    const textPattern = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>`, 'gu')
    const pieces = []
    for (const piece of body.matchAll(textPattern)) pieces.push(decodeXmlEntities(piece[1]))
    paragraphs.push(pieces.join(''))
  }
  return paragraphs.join('\n')
}

/* ───────────────────────────── Office 解析 ──────────────────────────── */

function parseDocx(buffer) {
  const zip = openZip(buffer)
  const warnings = []
  const main = zip.read('word/document.xml')
  if (main === undefined) {
    throw new ParseError('DOCX_NO_DOCUMENT', '.docx 里找不到 word/document.xml —— 容器结构异常。', {
      hint: '请用 Word/WPS 重新另存为 .docx。',
      stage: 'docx',
    })
  }
  const text = collectTagText(main.toString('utf8'), {
    paragraphTag: 'w:p',
    textTag: 'w:t',
    breaks: ['w:br', 'w:cr', 'w:tab'],
  })

  const headers = zip.names().filter(name => /^word\/(?:header|footer)\d*\.xml$/u.test(name))
  if (headers.length > 0) warnings.push(`含 ${headers.length} 个页眉/页脚部件，未纳入分析（正文判定不受影响）。`)
  if (zip.names().some(name => name.startsWith('word/embeddings/'))) {
    warnings.push('含内嵌对象（word/embeddings/），未解析 —— 其中的内容未参与评分。')
  }
  return { text, partsParsed: 1, partsExpected: 1, warnings }
}

function parsePptx(buffer) {
  const zip = openZip(buffer)
  const slides = zip.names()
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/u)[1]) - Number(b.match(/slide(\d+)/u)[1]))
  if (slides.length === 0) {
    throw new ParseError('PPTX_NO_SLIDES', '.pptx 里找不到 ppt/slides/slideN.xml —— 容器结构异常。', {
      hint: '请用 PowerPoint/WPS 重新另存为 .pptx。',
      stage: 'pptx',
    })
  }
  const chunks = []
  let parsed = 0
  for (const name of slides) {
    try {
      const xml = zip.read(name).toString('utf8')
      const slideText = collectTagText(xml, { paragraphTag: 'a:p', textTag: 'a:t', breaks: ['a:br'] })
      chunks.push(slideText)
      parsed += 1
    } catch {
      chunks.push('')
    }
  }
  const warnings = []
  if (parsed < slides.length) warnings.push(`有 ${slides.length - parsed} 页幻灯片未能解析，覆盖率已下调。`)
  if (zip.names().some(name => name.startsWith('ppt/notesSlides/'))) {
    warnings.push('含演讲者备注（notesSlides），未纳入分析。')
  }
  return { text: chunks.join('\n\n'), partsParsed: parsed, partsExpected: slides.length, warnings }
}

function parseXlsx(buffer) {
  const zip = openZip(buffer)
  const warnings = []
  const shared = []
  const sharedXml = zip.read('xl/sharedStrings.xml')
  if (sharedXml !== undefined) {
    for (const match of sharedXml.toString('utf8').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gu)) {
      const pieces = []
      for (const piece of match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)) pieces.push(decodeXmlEntities(piece[1]))
      shared.push(pieces.join(''))
    }
  }

  const sheets = zip.names().filter(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort()
  if (sheets.length === 0) {
    throw new ParseError('XLSX_NO_SHEET', '.xlsx 里找不到工作表 —— 容器结构异常。', {
      hint: '请用 Excel/WPS 重新另存为 .xlsx，或导出 .csv。',
      stage: 'xlsx',
    })
  }

  const chunks = []
  let parsed = 0
  for (const name of sheets) {
    try {
      const xml = zip.read(name).toString('utf8')
      const rows = []
      for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gu)) {
        const cells = []
        for (const cellMatch of rowMatch[1].matchAll(/<c(\s[^>]*)?>([\s\S]*?)<\/c>|<c(\s[^>]*)?\/>/gu)) {
          const attrs = cellMatch[1] ?? cellMatch[3] ?? ''
          const body = cellMatch[2] ?? ''
          const isShared = /\bt="s"/u.test(attrs)
          const valueMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/u.exec(body)
          const inlineMatch = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/u.exec(body)
          if (inlineMatch !== null) {
            const pieces = []
            for (const piece of inlineMatch[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)) pieces.push(decodeXmlEntities(piece[1]))
            cells.push(pieces.join(''))
          } else if (valueMatch !== null) {
            const raw = decodeXmlEntities(valueMatch[1])
            cells.push(isShared ? (shared[Number(raw)] ?? '') : raw)
          }
        }
        if (cells.some(cell => cell !== '')) rows.push(cells.join('\t'))
      }
      chunks.push(rows.join('\n'))
      parsed += 1
    } catch {
      chunks.push('')
    }
  }
  if (parsed < sheets.length) warnings.push(`有 ${sheets.length - parsed} 个工作表未能解析。`)
  warnings.push('表格按行列展平为文本；公式取缓存值，不重算。')
  return { text: chunks.join('\n\n'), partsParsed: parsed, partsExpected: sheets.length, warnings }
}

/* ─────────────────────────────── PDF ────────────────────────────────── */

/** 在 Buffer 里找所有 `<key> ... endstream` 之间的数据。 */
function collectStreams(bytes) {
  const streams = []
  let cursor = 0
  while (cursor < bytes.length) {
    const start = bytes.indexOf('stream', cursor, 'latin1')
    if (start < 0) break
    let dataStart = start + 6
    if (bytes[dataStart] === 0x0d) dataStart += 1
    if (bytes[dataStart] === 0x0a) dataStart += 1
    const end = bytes.indexOf('endstream', dataStart, 'latin1')
    if (end < 0) break
    let dataEnd = end
    while (dataEnd > dataStart && (bytes[dataEnd - 1] === 0x0a || bytes[dataEnd - 1] === 0x0d)) dataEnd -= 1
    streams.push(bytes.subarray(dataStart, dataEnd))
    cursor = end + 9
  }
  return streams
}

/** 从一段 PDF 内容流里抽 BT/ET 之间的文本。 */
function extractContentStreamText(content) {
  const pieces = []

  const decodeLiteral = literal => {
    let out = ''
    for (let at = 0; at < literal.length; at += 1) {
      const char = literal[at]
      if (char !== '\\') {
        out += char
        continue
      }
      const next = literal[at + 1] ?? ''
      if (next === 'n') { out += '\n'; at += 1; continue }
      if (next === 'r') { out += '\r'; at += 1; continue }
      if (next === 't') { out += '\t'; at += 1; continue }
      if (next === 'b' || next === 'f') { at += 1; continue }
      if (next === '(' || next === ')' || next === '\\') { out += next; at += 1; continue }
      const octal = /^[0-7]{1,3}/u.exec(literal.slice(at + 1, at + 4))
      if (octal !== null) {
        out += String.fromCharCode(Number.parseInt(octal[0], 8))
        at += octal[0].length
        continue
      }
      out += next
      at += 1
    }
    return out
  }

  const decodeHex = hex => {
    const clean = hex.replace(/[^0-9a-fA-F]/gu, '')
    let out = ''
    for (let at = 0; at + 2 <= clean.length; at += 2) {
      const code = Number.parseInt(clean.slice(at, at + 2), 16)
      // PDF 十六进制串多为单字节；按 Latin-1 处理，若全为 ASCII 结果正确
      if (code >= 32 && code < 127) out += String.fromCharCode(code)
      else if (code >= 0xa0) out += String.fromCharCode(code)
      else if (code === 32) out += ' '
    }
    return out
  }

  // 只处理 BT…ET 之间的文本算子；非文本算子（图形）一律忽略
  for (const block of content.matchAll(/BT([\s\S]*?)ET/gu)) {
    const body = block[1]
    for (const token of body.matchAll(/\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>/gu)) {
      const raw = token[0]
      if (raw.startsWith('<')) {
        pieces.push(decodeHex(raw.slice(1, -1)))
      } else {
        pieces.push(decodeLiteral(raw.slice(1, -1)))
      }
    }
    pieces.push(' ')
  }
  return pieces.join('')
}

function parsePdf(buffer, { maxChars }) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  const warnings = ['PDF 解析为启发式：只还原文本算子，不处理字体编码映射、分栏顺序与扫描件（无 OCR）。']
  const streams = collectStreams(bytes)
  if (streams.length === 0) {
    throw new ParseError('PDF_NO_STREAM', 'PDF 里找不到内容流 —— 可能是扫描件或加密文件。', {
      hint: '扫描件需先 OCR；加密 PDF 请先解除保护。也可让发送方提供 .docx。',
      stage: 'pdf',
    })
  }

  let decoded = 0
  const chunks = []
  for (const stream of streams) {
    let content
    try {
      content = inflateSync(stream).toString('latin1')
    } catch {
      content = stream.toString('latin1')
    }
    if (content.includes('Tj') || content.includes('TJ')) {
      decoded += 1
      chunks.push(extractContentStreamText(content))
    }
  }

  const text = chunks.join('\n')
  const printable = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u0020-\u007e]/gu) ?? []).length
  if (printable < 40) {
    warnings.push('可用文本极少（可能整页是图片/CID 字体），本次结论覆盖不足，已拒绝给总分。')
  }
  if (/\/Encrypt\b/u.test(bytes.toString('latin1'))) {
    warnings.push('检测到 /Encrypt —— 该 PDF 已加密，抽取内容可能不完整。')
  }

  const partsExpected = Math.max(decoded, streams.length)
  return {
    text: text.slice(0, maxChars),
    partsParsed: decoded,
    partsExpected,
    warnings,
    parseMode: 'pdf-heuristic',
  }
}

/* ────────────────────────────── 统一入口 ─────────────────────────────── */

/**
 * 解析任意支持的文件 → 规范文本 + 覆盖率 + 警告。
 * @param {{buffer: Buffer, filename: string}} input
 * @param {{maxChars?: number}} [options]
 */
export function parseFile(input, options = {}) {
  const maxChars = Number(options.maxChars ?? 600000)
  const filename = String(input.filename ?? '未命名')
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer ?? [])
  const ext = extensionOf(filename)

  if (buffer.length === 0) {
    throw new ParseError('EMPTY_FILE', '文件是空的（0 字节）。', { hint: '确认导出是否成功，或让对方重发。', stage: 'open' })
  }

  if (UNSUPPORTED_REASON[ext] !== undefined) {
    throw new ParseError('UNSUPPORTED_TYPE', `不支持的文件类型：.${ext}`, {
      hint: UNSUPPORTED_REASON[ext],
      stage: 'open',
    })
  }

  let result
  let format
  let label = ext

  if (ext === 'docx') {
    format = 'docx'
    result = parseDocx(buffer)
  } else if (ext === 'pptx') {
    format = 'pptx'
    result = parsePptx(buffer)
  } else if (ext === 'xlsx') {
    format = 'xlsx'
    result = parseXlsx(buffer)
  } else if (ext === 'pdf') {
    format = 'pdf'
    result = parsePdf(buffer, { maxChars })
  } else if (TEXT_EXT.has(ext) || ext === '') {
    format = ext === '' ? 'text' : ext
    const decoded = decodeText(buffer)
    let body = decoded.text
    if (ext === 'html' || ext === 'htm' || ext === 'xml') {
      body = body
        .replace(/<(script|style)[\s\S]*?<\/\1>/giu, ' ')
        .replace(/<br\s*\/?>/giu, '\n')
        .replace(/<\/(?:p|div|li|tr|h[1-6])>/giu, '\n')
        .replace(/<[^>]+>/gu, ' ')
      body = decodeXmlEntities(body)
    }
    if (ext === 'rtf') {
      body = body
        .replace(/\\par[d]?\b/gu, '\n')
        .replace(/\{\\[^{}]*\}/gu, ' ')
        .replace(/\\[a-zA-Z]+-?\d*\s?/gu, ' ')
        .replace(/[{}]/gu, ' ')
    }
    result = {
      text: body,
      partsParsed: 1,
      partsExpected: 1,
      warnings: decoded.encoding === 'utf-8-lossy'
        ? ['该文件不是合法 UTF-8，也不是可识别的 GBK —— 有乱码字符，结论可信度已下调。']
        : [],
    }
    label = `${ext || 'text'}(${decoded.encoding})`
  } else {
    throw new ParseError('UNKNOWN_TYPE', `不认识的文件类型：.${ext}`, {
      hint: '支持：txt / md / csv / json / html / docx / pptx / xlsx / pdf。请另存为其中之一。',
      stage: 'open',
    })
  }

  const normalized = normalizeText(result.text ?? '')
  const truncated = normalized.length > maxChars
  const text = truncated ? normalized.slice(0, maxChars) : normalized

  let coverage = result.partsExpected === 0 ? 0 : result.partsParsed / result.partsExpected
  if (format === 'pdf') {
    // PDF 的"部件"是内容流，解码成功不等于抽出了字。
    // 用可读字符量做二次修正：抽不到字的 PDF 覆盖率必须掉下来，否则会给出"没发现问题"的假结论。
    const printable = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u0020-\u007e]/gu) ?? []).length
    const density = text.length === 0 ? 0 : printable / text.length
    coverage = Math.min(coverage, density < 0.5 ? 0.35 : density)
  }
  if (truncated) coverage = Math.min(coverage, 0.9)
  coverage = Math.max(0, Math.min(1, Number(coverage.toFixed(3))))

  const warnings = [...(result.warnings ?? [])]
  if (truncated) warnings.push(`文本超过 ${maxChars} 字符上限，已截断；截断后的结论不代表全文。`)
  if (text.trim() === '') warnings.push('解析出的文本为空 —— 无法评分。')

  return {
    ok: true,
    filename,
    format,
    label,
    text,
    chars: text.length,
    coverage,
    parseMode: result.parseMode ?? 'exact',
    warnings,
    truncated,
  }
}
