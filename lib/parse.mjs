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
 * 支持矩阵（逐项由 test/parse.test.mjs 覆盖）：
 *   .txt/.md/.csv/.json/.log/.yaml/.html  直读（UTF-8 / UTF-16 BOM / GBK 兜底）
 *   .docx/.docm/.dotx                     ZIP → word/document.xml → w:p / w:t
 *   .pptx/.pptm/.potx                     ZIP → ppt/slides/slideN.xml → a:p / a:t
 *   .xlsx/.xlsm/.xltx                     ZIP → xl/sharedStrings.xml + xl/worksheets/sheetN.xml
 *   .odt/.ods/.odp                        ZIP → content.xml → 段落级去标签
 *   .pdf                                  内容流 inflate → BT/ET 文本算子（启发式，会明示）
 *   .doc/.xls/.ppt（旧二进制）、图片、压缩包   → 明确不支持，给出可执行的下一步
 *
 * ★ 0.7.17：**不信扩展名，信内容。**
 *   学校/政务/办公系统导出的"表.docx"里装的经常是网页 HTML、RTF、或旧版 .doc；
 *   这类文件以前只会拿到「未找到中央目录」——话没错，但对用户没有下一步，而且
 *   把"扩展名写错了"和"文件坏了"混成了同一个报错。
 *   现在先按**魔数**判型：
 *     · 内容能读 → 就按真实格式读（并在报告里标出"扩展名与内容不符"）；
 *     · 内容读不了 → 说清它到底是什么（旧版 .doc / 设了打开密码 / 下载被截断 / 未知二进制），
 *       并给出**一个**具体动作。
 *   扩展名从此只用来在 ZIP 内部区分 docx/pptx/xlsx/odf —— 且这个区分也要跟
 *   `[Content_Types].xml` 对一遍，对不上以内容为准。
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

/**
 * "其实是 ZIP"的扩展名 → 真正该用的解析器。
 * 带宏的 .docm/.xlsm/.pptm 与模板 .dotx 的正文结构和 .docx 完全一致（vbaProject.bin 我们本来就不读），
 * 以前它们全被判成「不认识的文件类型」—— 白挡了一大批真实文件。
 */
const OOXML_FAMILY = {
  docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx',
  pptx: 'pptx', pptm: 'pptx', potx: 'pptx', potm: 'pptx',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', xltm: 'xlsx',
}
/** ODF（LibreOffice / WPS 另存）—— 同样是 ZIP + XML。 */
const ODF_FAMILY = {
  odt: 'odt', ott: 'odt', ods: 'ods', ots: 'ods', odp: 'odp', otp: 'odp',
}

/** 取小写扩展名（不含点）。容忍首尾空格 —— "方案.docx " 这种从邮件/聊天里存下来的名字很常见。 */
export function extensionOf(filename) {
  const name = String(filename ?? '').trim()
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).trim().toLowerCase()
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

/* ──────────────────────────── 格式嗅探 ───────────────────────────── */

/**
 * "这段字节有多像文本"：0 = 二进制，1 = 干净文本。
 *
 * ★ 为什么不是数"可打印字节"：UTF-8 的中文每个字占 3 字节，其中只有 1 个首字节
 *   落在可打印区间，一篇纯中文会被算成 1/3 —— 直接判成二进制。必须按**解码后**的
 *   非法序列比例来判，而不是按字节。
 */
function textLikeness(bytes, limit = 8192) {
  const sample = bytes.subarray(0, Math.min(bytes.length, limit))
  if (sample.length === 0) return 0
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample)
  if (decoded.length === 0) return 0
  let bad = 0
  for (const char of decoded) {
    const code = char.codePointAt(0)
    if (code === 0xfffd) { bad += 1; continue }          // 非法 UTF-8 序列被替换掉了
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 0x20) bad += 1                            // 其它控制字符
  }
  return 1 - bad / decoded.length
}

/** 头部 8 字节的十六进制 —— 用于"未知二进制"的诊断，让用户能把证据贴回来。 */
function headHex(bytes) {
  return bytes.subarray(0, 8).toString('hex').replace(/(..)(?=.)/gu, '$1 ').toUpperCase()
}

/**
 * 按**内容**判型，不看扩展名。扩展名可以骗人，魔数不行。
 *
 * @returns {{kind: 'empty'|'zip'|'ole2'|'pdf'|'rtf'|'html'|'xml'|'text'|'unknown', label: string}}
 */
export function sniffFormat(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (bytes.length === 0) return { kind: 'empty', label: '空文件（0 字节）' }

  // ZIP：本地文件头 PK\x03\x04 / 空档 PK\x05\x06 / 跨卷 PK\x07\x08
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return { kind: 'zip', label: 'ZIP 容器（Office 2007+ 或 ODF）' }
  }

  // OLE2 复合文档：旧版 .doc/.xls/.ppt，**以及设了打开密码的新版 Office 文件**
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return { kind: 'ole2', label: 'OLE2 复合文档（Word 97-2003，或设了打开密码的 Office 文件）' }
  }

  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { kind: 'pdf', label: 'PDF 文档' }
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { kind: 'text', label: 'UTF-16LE 文本' }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { kind: 'text', label: 'UTF-16BE 文本' }

  const skipBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  const head = bytes.subarray(skipBom, Math.min(bytes.length, skipBom + 2048)).toString('latin1').replace(/^\s+/u, '')

  if (/^\{\\rtf/u.test(head)) return { kind: 'rtf', label: 'RTF 富文本' }

  if (head.startsWith('<')) {
    // 办公软件"另存为网页"会带 xmlns:o / mso 命名空间；前端剪贴也常以 <!--StartFragment--> 开头
    if (/<html[\s>]|<!doctype\s+html|<meta[\s>]|<body[\s>]|<!--\s*startfragment/iu.test(head)) {
      return { kind: 'html', label: 'HTML 网页' }
    }
    return { kind: 'xml', label: 'XML / Flat OPC 文档' }
  }
  if (/^mime-version:/iu.test(head)) return { kind: 'text', label: 'MHT / 邮件合成文本' }

  if (textLikeness(bytes) >= 0.85) return { kind: 'text', label: '纯文本' }

  return { kind: 'unknown', label: `无法识别的二进制（头部 ${headHex(bytes)}）` }
}

/* ───────────────────── OLE2 复合文档：只为读出流名字 ──────────────────── */

/**
 * 最小 CFB（OLE2）目录读取器 —— **只读流名字，不读内容**。
 *
 * 为什么需要它：`.docx` 与"设了打开密码的 .docx"在字节层面都可能是 OLE2，
 * 但对用户来说是两个完全不同的下一步（"另存为"vs"先解除密码"）。
 * 不读名字就只能含糊地说"这是旧格式"，等于把判断成本转嫁给用户。
 *
 * 任何一步对不上就返回空数组 —— 探不到名字只让诊断变粗，不影响主流程。
 */
export function readOle2StreamNames(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (bytes.length < 512) return []

  const sectorSize = bytes.readUInt16LE(0x1e) === 0x0c ? 4096 : 512
  const dirStart = bytes.readUInt32LE(0x30)
  const sectorAt = sector => (sector + 1) * sectorSize
  const readSector = sector => {
    const start = sectorAt(sector)
    if (start < 0 || start + sectorSize > bytes.length) return undefined
    return bytes.subarray(start, start + sectorSize)
  }

  // DIFAT 前 109 项就在头部（0x4C 起）；小文件的第一项就是 FAT 所在扇区
  let fatSector
  for (let index = 0; index < 109; index += 1) {
    const sector = bytes.readUInt32LE(0x4c + index * 4)
    if (sector !== 0xffffffff) { fatSector = sector; break }
  }
  if (fatSector === undefined) return []
  const fatBytes = readSector(fatSector)
  if (fatBytes === undefined) return []
  /** FAT 第 sector 项 = 该扇区的下一扇区（0xFFFFFFFE 表示链尾）。 */
  const nextSector = sector => {
    const at = sector * 4
    return at + 4 <= fatBytes.length ? fatBytes.readUInt32LE(at) : 0xfffffffe
  }

  const names = []
  let cursor = dirStart
  for (let guard = 0; guard < 64; guard += 1) {
    if (cursor === 0xfffffffe || cursor === 0xffffffff) break
    const sector = readSector(cursor)
    if (sector === undefined) break
    for (let at = 0; at + 128 <= sector.length; at += 128) {
      const nameLen = sector.readUInt16LE(at + 0x40)
      const type = sector[at + 0x42]
      if (type === 0 || nameLen < 2 || nameLen > 64) continue
      const name = sector.toString('utf16le', at, at + nameLen - 2)
      if (name !== '') names.push(name)
    }
    cursor = nextSector(cursor)
  }
  return names
}

/** 用流名字回答"这份 OLE2 到底是什么"。 */
export function diagnoseOle2(buffer) {
  const names = readOle2StreamNames(buffer)
  const has = needle => names.some(name => name.toLowerCase().includes(needle))
  if (has('encryptioninfo') || has('encryptedpackage')) return 'encrypted-ooxml'
  if (has('worddocument')) return 'doc'
  if (has('workbook') || has('book')) return 'xls'
  if (has('powerpoint document')) return 'ppt'
  return 'ole2-generic'
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
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50

/**
 * 最小 ZIP 读取器：只读中央目录 + 按需解压单个条目。
 * 任何一步"对不上"都要说清是**哪一类**对不上（截断 / ZIP64 / 加密 / 损坏），
 * 因为这四类的下一步动作完全不同。
 */
export function openZip(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  const size = bytes.length

  // EOCD 本身就有 22 字节；比它还短的文件根本装不下中央目录。
  // 以前这种文件会撞上"未找到中央目录"——话没错，但把"没下完"说成了"不是 ZIP"。
  if (size < 22) {
    throw new ParseError('ZIP_TRUNCATED', `文件只有 ${size} 字节，短到不可能是完整的 ZIP 容器 —— 几乎肯定是没下完。`, {
      hint: '重新下载或重新导出一次。若来源是网页系统，请用「另存为」，不要"打开后保存"。',
      stage: 'zip',
    })
  }

  let eocd = -1
  const scanFloor = Math.max(0, size - 66000)
  for (let at = size - 22; at >= scanFloor; at -= 1) {
    if (bytes.readUInt32LE(at) === EOCD_SIG) {
      eocd = at
      break
    }
  }
  if (eocd < 0) {
    // 能走到这里说明**开头确实是 PK**（调用方已按魔数判过型），但没有中央目录尾。
    // 这是"文件不完整"，不是"扩展名写错了"——两者以前共用一个报错。
    throw new ParseError('ZIP_TRUNCATED', `开头是 ZIP 但找不到中央目录（共 ${(size / 1024).toFixed(1)} KB）—— 文件不完整，通常没下载完。`, {
      hint: '重新下载一次；若反复如此，请让发送方改用「另存为 .docx」或发 PDF。',
      stage: 'zip',
    })
  }

  let cdOffset = bytes.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff) {
    // ZIP64：EOCD 之前 20 字节是定位器，真偏移在 ZIP64 目录尾里
    const locator = eocd - 20
    if (locator >= 0 && bytes.readUInt32LE(locator) === ZIP64_LOCATOR_SIG) {
      const zip64Eocd = Number(bytes.readBigUInt64LE(locator + 8))
      if (zip64Eocd + 56 <= size && bytes.readUInt32LE(zip64Eocd) === ZIP64_EOCD_SIG) {
        cdOffset = Number(bytes.readBigUInt64LE(zip64Eocd + 48))
      }
    }
  }
  if (cdOffset === 0xffffffff || cdOffset + 46 > size) {
    throw new ParseError('ZIP64_UNSUPPORTED', '该文件是 ZIP64 容器，暂不支持。', {
      hint: '这通常是超大或特殊工具导出的 Office 文件；请拆小，或导出为 .pdf 再分析。',
      stage: 'zip',
    })
  }

  // ★ 不按 EOCD 里的 entryCount 循环：ZIP64 下它是 0xFFFF 占位值，超过 65535 个条目也会撞上限。
  //   中央目录每一条都以 CD_SIG 开头，走到签名换成别的就是真结尾 —— 用结构判断，不用声明判断。
  const entries = new Map()
  let cursor = cdOffset
  for (let guard = 0; guard < 200000; guard += 1) {
    if (cursor + 46 > size || bytes.readUInt32LE(cursor) !== CD_SIG) break
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
  if (entries.size === 0) {
    throw new ParseError('ZIP_NO_ENTRY', '找到了 ZIP 目录尾，但里面一条条目都读不出来 —— 容器已损坏。', {
      hint: '用办公软件重新打开并另存一次；打不开就是文件坏了，请向发送方要一份新的。',
      stage: 'zip',
    })
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
    const dataEnd = dataStart + entry.compSize
    // 条目数据超出文件末尾 = 文件被截断。以前会 subarray 出一个短 Buffer，
    // 再在 inflate 里炸出一句跟真实原因无关的"解压失败"。
    if (entry.compSize === 0xffffffff || dataEnd > bytes.length) {
      throw new ParseError('ZIP_TRUNCATED', `ZIP 条目数据不完整：${name} —— 文件被截断。`, {
        hint: '重新下载或重新导出一次，文件没下完。',
        stage: 'zip',
      })
    }
    const data = bytes.subarray(dataStart, dataEnd)
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

/**
 * ZIP 里装的到底是哪一种办公文档 —— 先看 `[Content_Types].xml`，再退到目录结构。
 * 扩展名写错（把 .xlsx 存成 .docx）时按**真实类型**读，而不是报"容器结构异常"。
 * @returns {'docx'|'pptx'|'xlsx'|'odt'|'ods'|'odp'|'odf'|''}
 */
export function guessOfficeKind(zip) {
  let types = ''
  try {
    types = zip.read('[Content_Types].xml')?.toString('utf8') ?? ''
  } catch {
    /* 这条读不到就靠目录结构判断，不影响主流程 */
  }
  if (/wordprocessingml|ms-word\./u.test(types)) return 'docx'
  if (/presentationml|ms-powerpoint\./u.test(types)) return 'pptx'
  if (/spreadsheetml|ms-excel\./u.test(types)) return 'xlsx'
  if (/opendocument\.text/u.test(types)) return 'odt'
  if (/opendocument\.spreadsheet/u.test(types)) return 'ods'
  if (/opendocument\.presentation/u.test(types)) return 'odp'

  let names = []
  try { names = zip.names() } catch { return '' }
  if (names.includes('word/document.xml')) return 'docx'
  if (names.some(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))) return 'pptx'
  if (names.some(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))) return 'xlsx'
  if (names.includes('content.xml')) return 'odf'
  return ''
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
  const xml = main.toString('utf8')
  const text = collectTagText(xml, {
    paragraphTag: 'w:p',
    textTag: 'w:t',
    breaks: ['w:br', 'w:cr', 'w:tab'],
  })

  const headers = zip.names().filter(name => /^word\/(?:header|footer)\d*\.xml$/u.test(name))
  if (headers.length > 0) warnings.push(`含 ${headers.length} 个页眉/页脚部件，未纳入分析（正文判定不受影响）。`)
  if (zip.names().some(name => name.startsWith('word/embeddings/'))) {
    warnings.push('含内嵌对象（word/embeddings/），未解析 —— 其中的内容未参与评分。')
  }
  // ★ 覆盖率必须诚实：容器完整 ≠ 正文抽到了。
  //   整篇 Word 只有一张图/一个文本框时，以前会报"覆盖率 100% + 文本为空"，
  //   下游据此把空文档送去评审，模型对着一片空白打分。抽不到字就是 0 覆盖。
  if (text.trim() === '') {
    warnings.push(/<w:drawing|<w:pict|<v:imagedata|<w:object/u.test(xml)
      ? '正文里没有段落文字，只找到图片/图形/嵌入对象 —— 本插件不做 OCR，这份文件读不出可用于评分的内容。'
      : '正文里没有任何文字。')
  }
  return { text, partsParsed: text.trim() === '' ? 0 : 1, partsExpected: 1, warnings }
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
  // 幻灯片全部是图片/形状而没有文字时，"读到了 3 页"和"抽到了字"是两件事 —— 覆盖率按后者算。
  if (chunks.join('').trim() === '') parsed = 0
  if (parsed < slides.length) warnings.push(`有 ${slides.length - parsed} 页幻灯片未能解析，覆盖率已下调。`)
  if (zip.names().some(name => name.startsWith('ppt/notesSlides/'))) {
    warnings.push('含演讲者备注（notesSlides），未纳入分析。')
  }
  return { text: chunks.join('\n\n'), partsParsed: parsed, partsExpected: slides.length, warnings }
}

/**
 * ODF（.odt/.ods/.odp）—— 同样是 ZIP + XML，但正文没有"一个字一个标签"的结构，
 * 只能按段落去标签。表格结构会丢，故明示。
 */
function parseOdf(buffer) {
  const zip = openZip(buffer)
  const xml = zip.read('content.xml')?.toString('utf8')
  if (xml === undefined) {
    throw new ParseError('ODF_NO_CONTENT', '这是 OpenDocument 容器，但里面没有 content.xml —— 结构异常。', {
      hint: '请用 WPS/LibreOffice 打开后另存为 .docx（文字）或 .xlsx（表格）。',
      stage: 'odf',
    })
  }
  const paragraphs = []
  for (const match of xml.matchAll(/<text:(p|h)(?:\s[^>]*)?>([\s\S]*?)<\/text:\1>/gu)) {
    const body = match[2]
      .replace(/<text:s(?:\s[^>]*)?\/>/gu, ' ')
      .replace(/<text:tab(?:\s[^>]*)?\/>/gu, '\t')
      .replace(/<text:line-break(?:\s[^>]*)?\/>/gu, '\n')
      .replace(/<[^>]*>/gu, '')
    paragraphs.push(decodeXmlEntities(body))
  }
  const text = paragraphs.join('\n')
  return {
    text,
    partsParsed: text.trim() === '' ? 0 : 1,
    partsExpected: 1,
    warnings: ['OpenDocument 格式按段落抽取：表格结构、页眉页脚展平为普通文本。'],
  }
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
  if (chunks.join('').trim() === '') parsed = 0
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
 * 文本类清洗：kind 决定要不要剥标记。
 * @param {'text'|'html'|'xml'|'rtf'} kind
 */
function readLooseText(buffer, kind) {
  const decoded = decodeText(buffer)
  let body = decoded.text
  if (kind === 'html' || kind === 'xml') {
    body = body
      .replace(/<(script|style)[\s\S]*?<\/\1>/giu, ' ')
      .replace(/<w:(?:br|cr)\s*\/>/giu, '\n')
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6]|w:p|text:p|w:tr)>/giu, '\n')
      .replace(/<[^>]+>/gu, ' ')
    body = decodeXmlEntities(body)
  }
  if (kind === 'rtf') {
    body = body
      .replace(/\\par[d]?\b/gu, '\n')
      .replace(/\{\\[^{}]*\}/gu, ' ')
      .replace(/\\[a-zA-Z]+-?\d*\s?/gu, ' ')
      .replace(/[{}]/gu, ' ')
  }
  return {
    text: body,
    partsParsed: 1,
    partsExpected: 1,
    warnings: decoded.encoding === 'utf-8-lossy'
      ? ['该文件不是合法 UTF-8，也不是可识别的 GBK —— 有乱码字符，结论可信度已下调。']
      : [],
    encoding: decoded.encoding,
  }
}

/** OLE2 —— 说清"是旧版二进制"还是"设了密码"，这两者的下一步完全不同。 */
function ole2Error(buffer, ext) {
  const kind = diagnoseOle2(buffer)
  const declared = ext === '' ? '这个文件' : `.${ext} 文件`
  const stage = 'open'
  if (kind === 'encrypted-ooxml') {
    return new ParseError('ENCRYPTED_OFFICE', `${declared}设了打开密码：内容被加密在 OLE2 容器里，插件读不到正文。`, {
      hint: '在 Word/Excel 里用密码打开 →「另存为」→ 点「工具 → 常规选项」清空密码 → 存成 .docx 再上传。',
      stage,
    })
  }
  if (kind === 'doc' || kind === 'xls' || kind === 'ppt') {
    const legacy = { doc: 'Word 文档（*.docx）', xls: 'Excel 工作簿（*.xlsx）', ppt: 'PowerPoint 演示文稿（*.pptx）' }[kind]
    return new ParseError('LEGACY_OFFICE', `${declared}的内容其实是旧版 Office 二进制格式（.${kind}）—— 扩展名叫什么不影响它的实际格式。`, {
      hint: `用 Word/WPS/Excel 打开它 →「另存为」→ 选「${legacy}」→ 上传新文件。`,
      stage,
    })
  }
  return new ParseError('OLE2_DOCUMENT', `${declared}是 OLE2 复合文档（旧版 Office 或加密的 Office 文件），插件读不到正文。`, {
    hint: '用办公软件打开后「另存为」.docx / .xlsx / .pptx；若提示要密码，先解除密码。',
    stage,
  })
}

/** 内容读不了时，按"它到底是什么"给出**一个**动作 —— 不是一串可能。 */
function unreadableError({ ext, sniff, buffer }) {
  const size = (buffer.length / 1024).toFixed(1)
  const declared = ext === '' ? '没写扩展名' : `扩展名是 .${ext}`
  const stage = 'open'
  if (OOXML_FAMILY[ext] !== undefined || ODF_FAMILY[ext] !== undefined) {
    return new ParseError('CONTAINER_NOT_FOUND',
      `文件${declared}，但内容不是 Office 容器：${sniff.label}；共 ${size} KB。`, {
        hint: '两种可能：① 网页/办公系统导出的"伪 Office 文件" —— 用办公软件打开后「另存为」真正的 .docx；② 文件坏了 —— 向发送方要一份新的。',
        stage,
      })
  }
  if (ext === 'pdf') {
    return new ParseError('NOT_PDF', `文件${declared}，但内容不是 PDF：${sniff.label}；共 ${size} KB。`, {
      hint: '多半是"下载成了网页"。请重新下载；或让对方直接发原始文件。',
      stage,
    })
  }
  return new ParseError('UNKNOWN_CONTENT', `无法解析这个文件：${sniff.label}；共 ${size} KB。`, {
    hint: '支持：docx / docm / pptx / xlsx / odt / ods / odp / pdf / txt / md / csv / json / html。'
      + '若是扫描件或图片，请先转成可复制文字的 PDF 或 .docx。',
    stage,
  })
}

/** 内容是 ZIP：按容器里的**真实**类型选解析器，扩展名只作对照。 */
function parseZipContainer({ buffer, ext, noteMismatch }) {
  const zip = openZip(buffer)
  const kind = guessOfficeKind(zip)
  if (kind === '') {
    throw new ParseError('ZIP_NOT_OFFICE', '这是一个普通 ZIP 压缩包 —— 里面没有 Word/Excel/PPT 的文档结构。', {
      hint: '压缩包不展开分析（防止压缩炸弹）。请解压后把要分析的那个文件单独上传。',
      stage: 'open',
    })
  }
  const declared = OOXML_FAMILY[ext] ?? ODF_FAMILY[ext] ?? ''
  const kindLabel = kind === 'odf' ? 'OpenDocument' : kind
  // 扩展名与容器真实类型对不上（含"扩展名压根不是 Office 格式"）→ 记一条，但仍按内容读
  const agreesWithExt = declared === kind || (kind === 'odf' && ODF_FAMILY[ext] !== undefined)
  if (!agreesWithExt && (declared !== '' || ext !== '')) noteMismatch(`${kindLabel} 结构`)

  if (kind === 'docx') return { format: 'docx', result: parseDocx(buffer) }
  if (kind === 'pptx') return { format: 'pptx', result: parsePptx(buffer) }
  if (kind === 'xlsx') return { format: 'xlsx', result: parseXlsx(buffer) }
  return { format: kind === 'odf' ? (ODF_FAMILY[ext] ?? 'odf') : kind, result: parseOdf(buffer) }
}

/** 旧版二进制扩展名：网页系统常把它们导出成 HTML，所以有可读内容就继续读。 */
const LEGACY_OFFICE_EXT = new Set(['doc', 'xls', 'ppt'])

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

  const sniff = sniffFormat(buffer)
  /** 扩展名与内容不一致的说明 —— 不静默纠正，也不当成错误，写进报告让人看得见。 */
  const notes = []
  const noteMismatch = actual => {
    const declared = ext === '' ? '没写扩展名' : `.${ext}`
    notes.push(`扩展名与内容不符：文件名是 ${declared}，内容其实是${actual} —— 已按内容解析。`)
  }

  // ① OLE2：旧版 .doc/.xls/.ppt 与"设了密码的 Office 文件"都在这里，必须在扩展名表之前拦下
  if (sniff.kind === 'ole2') throw ole2Error(buffer, ext)

  // ② 硬不支持的类型（压缩包、图片、邮件）：唯一例外是"旧版扩展名 + 内容能被识别"——
  //    网页系统导出的 .doc 十有八九是 HTML，改名成 .doc 的 .docx 也不少，这种要读，不是要拒。
  const readableKind = sniff.kind !== 'unknown'
  if (UNSUPPORTED_REASON[ext] !== undefined && !(LEGACY_OFFICE_EXT.has(ext) && readableKind)) {
    throw new ParseError('UNSUPPORTED_TYPE', `不支持的文件类型：.${ext}`, {
      hint: UNSUPPORTED_REASON[ext],
      stage: 'open',
    })
  }

  let result
  let format
  let label

  if (sniff.kind === 'zip') {
    const parsed = parseZipContainer({ buffer, ext, noteMismatch })
    format = parsed.format
    result = parsed.result
  } else if (sniff.kind === 'pdf') {
    if (ext !== 'pdf') noteMismatch('PDF 文档')
    format = 'pdf'
    result = parsePdf(buffer, { maxChars })
  } else if (sniff.kind === 'html' || sniff.kind === 'rtf' || sniff.kind === 'xml') {
    format = sniff.kind
    if (ext !== '' && ext !== 'html' && ext !== 'htm' && ext !== 'xml' && ext !== 'rtf') noteMismatch(sniff.label)
    result = readLooseText(buffer, sniff.kind)
  } else if (sniff.kind === 'text') {
    const cleanKind = ext === 'html' || ext === 'htm' || ext === 'xml' ? 'html'
      : ext === 'rtf' ? 'rtf'
        : 'text'
    // 明明是纯文本却顶着 .docx / .pdf / .doc 的名字 —— 这正是"网页导出的假 Office 文件"。
    if (ext !== '' && !TEXT_EXT.has(ext)) noteMismatch(sniff.label)
    format = ext === '' ? 'text' : ext
    result = readLooseText(buffer, cleanKind)
  } else {
    // 认不出内容时，若**扩展名本身**是文本格式，仍交给 decodeText 的 GBK / UTF-16 兜底 ——
    // GBK 编码的中文在 sniffFormat 眼里是"非法 UTF-8"，但它确实是文本，不能因此拒收。
    if (TEXT_EXT.has(ext) || ext === '') {
      format = ext === '' ? 'text' : ext
      result = readLooseText(buffer, ext === 'html' || ext === 'htm' || ext === 'xml' ? 'html' : ext === 'rtf' ? 'rtf' : 'text')
    } else {
      throw unreadableError({ ext, sniff, buffer })
    }
  }

  // label 一律反映**实际用的解析器**，而不是扩展名 —— 否则报告里会写"格式 docx"却按 PDF 读的。
  label = result.encoding !== undefined ? `${format}(${result.encoding})` : format

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

  const warnings = [...notes, ...(result.warnings ?? [])]
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
