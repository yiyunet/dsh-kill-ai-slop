// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/text.mjs
/**
 * 文本切分与度量 —— 全部为纯函数，零依赖、零 IO。
 *
 * ★ 一切的基准是「规范文本」：`normalizeText()` 的输出。
 *   所有 start/end 偏移量都是相对规范文本的字符下标（UTF-16 code unit）。
 *   下游要引原文片段，必须用同一份规范文本去 slice，否则偏移会漂。
 *
 * 中文与英文的切句、断词规则**分开**实现，不互译：
 * 中文没有空格分词、句末标点形态不同、引号成对出现 —— 一套正则硬套两边，
 * 结果是"英文句子被中文标点切断"这类静默错误（"语言偏差"风险）。
 */

const CJK_RANGE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const CJK_GLOBAL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu
const LATIN_WORD = /[A-Za-z][A-Za-z'’\-]*/gu

/** 句末标点（中文）与可跟在标点后的收尾引号。 */
const CJK_TERMINATORS = new Set(['。', '！', '？', '；', '…'])
const LATIN_TERMINATORS = new Set(['!', '?', ';'])
const CLOSERS = new Set(['」', '』', '”', '’', '）', ')', '】', '》', '"', "'"])

/** 挂在句首、本身几乎不承载信息的标记（用于"句首重复"类结构判定）。 */
export const STRUCTURAL_PREFIX = /^(?:[-*+•]|\d{1,2}[.)、]|#{1,6}\s|>\s*)/u

/**
 * 规范文本：去 BOM、统一换行、去 NUL。
 * 只做这三件事 —— 任何更多改写都会让偏移与原文对不上。
 */
export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u0000/gu, '')
}

/** 是否含 CJK 字符。 */
export function hasCJK(text) {
  return CJK_RANGE.test(text ?? '')
}

/** 主脚本类型：'cjk' | 'latin' | 'mixed' | 'none'。 */
export function detectScript(text) {
  const source = String(text ?? '')
  const cjk = (source.match(CJK_GLOBAL) ?? []).length
  const latin = (source.match(LATIN_WORD) ?? []).length
  if (cjk === 0 && latin === 0) return 'none'
  if (cjk === 0) return 'latin'
  if (latin === 0) return 'cjk'
  // 中文文档里夹英文术语很常见（"ROI"、"PDF"），按 1 个英文词 ≈ 1.5 个汉字折算，
  // 避免一篇中文报告因为术语多被判成 mixed。
  return cjk >= latin * 1.5 ? 'cjk' : (latin > cjk * 3 ? 'latin' : 'mixed')
}

/**
 * 切段：一段 = 连续非空行。
 * @returns {{text: string, start: number, end: number, lines: number}[]}
 */
export function splitParagraphs(text) {
  const source = String(text ?? '')
  const paragraphs = []
  let cursor = 0
  let blockStart = -1
  let blockEnd = -1
  let lines = 0

  const flush = () => {
    if (blockStart < 0) return
    paragraphs.push({
      text: source.slice(blockStart, blockEnd),
      start: blockStart,
      end: blockEnd,
      lines,
    })
    blockStart = -1
    blockEnd = -1
    lines = 0
  }

  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      flush()
    } else {
      if (blockStart < 0) blockStart = cursor
      blockEnd = cursor + line.length
      lines += 1
    }
    cursor += line.length + 1
  }
  flush()
  return paragraphs
}

/**
 * 切句：逐字符扫描，中文按 中文句末标点 断，英文按 .!?; 断。
 * 偏移绝对准确（下游要拿它回原文取证据）。
 * @returns {{text: string, start: number, end: number, index: number}[]}
 */
export function splitSentences(text) {
  const source = String(text ?? '')
  const sentences = []
  let start = 0
  let index = 0

  const push = end => {
    const raw = source.slice(start, end)
    const trimmed = raw.trim()
    if (trimmed !== '') {
      const leading = raw.length - raw.trimStart().length
      sentences.push({
        text: trimmed,
        start: start + leading,
        end: start + leading + trimmed.length,
        index,
      })
      index += 1
    }
    start = end
  }

  for (let at = 0; at < source.length; at += 1) {
    const char = source[at]
    let boundary = false

    if (CJK_TERMINATORS.has(char)) {
      boundary = true
      // 吃掉紧跟的收尾引号/括号，避免「」被甩到下一句
      while (at + 1 < source.length && CLOSERS.has(source[at + 1])) at += 1
    } else if (LATIN_TERMINATORS.has(char)) {
      boundary = true
      while (at + 1 < source.length && CLOSERS.has(source[at + 1])) at += 1
    } else if (char === '\n') {
      boundary = true
    } else if (char === '.') {
      // 英文句点：排除小数（3.5）、紧贴字母的缩写（e.g. / Inc.）、编号（1.）；
      // 并且要求后面确实像是句尾（结尾 / 空白+大写 / 空白+引号括号）。
      // 不做这一步，中文正文里的 "e.g. 表格" 会被切成两句 —— 这类静默切错会让偏移全乱。
      const prev = source[at - 1] ?? ''
      const next = source[at + 1] ?? ''
      const isDecimal = /\d/u.test(prev) && /\d/u.test(next)
      const isAbbrev = /[A-Za-z]/u.test(prev) && /[A-Za-z]/u.test(next)
      const isListNumber = /\d/u.test(prev) && (next === '' || /\s/u.test(next))
      const after = source.slice(at + 1, at + 3)
      const looksLikeEnd = next === '' || /^\s+[A-Z"'(\[]/u.test(after) || /^\s*$/u.test(after)
      if (!isDecimal && !isAbbrev && !isListNumber && looksLikeEnd) {
        boundary = true
        while (at + 1 < source.length && CLOSERS.has(source[at + 1])) at += 1
      }
    }

    if (boundary) push(at + 1)
  }
  push(source.length)
  return sentences
}

/** 句子是否为"实质句"的弱判据：含数字、日期、单位或专有名词形态。 */
const FACT_NUMBER = /-?\d+(?:[.,]\d+)?/u
const FACT_DATE = /(?:\d{4}\s*[-/年]\s*\d{1,2})|(?:\d{1,2}\s*月\s*\d{1,2}\s*日)|(?:Q[1-4])|(?:(?:19|20)\d{2}\s*年)/u
const FACT_UNIT = /(%|％|元|万元|亿元|美元|USD|CNY|RMB|EUR|GBP|小时|分钟|秒|天|周|个月|人次?|次|倍|件|台|个|吨|kg|g|MB|GB|TB|ms|pcs|units?|hours?|days?|weeks?|months?|years?|times)/iu

/** 「因为/导致/取决于」等机制连词 —— 有机制描述算实质内容（弱信号）。 */
const MECHANISM = /(因为|由于|导致|取决于|由.{0,8}(?:组成|构成)|机制|原理|从而|使得|causes?|because|depends on|consists of|mechanism)/iu

/** 否定标记（保护项，压缩时不得删）。 */
const NEGATION = /(不|未|无|非|没|禁止|不得|尚未|无法|\bno\b|\bnot\b|\bnever\b|\bwithout\b|\bcannot\b|\bcan't\b)/iu
/** 条件标记（保护项）。 */
const CONDITION = /(若|如果|当|除非|前提|假设|只有|一旦|\bif\b|\bunless\b|\bprovided\b|\bwhen\b|\bassuming\b)/iu
/** 不确定性标记（保护项）。 */
const UNCERTAIN = /(可能|预计|估计|大概|约|左右|尚无|待[定验补]|未验证|待验证|不确定|\bapprox|\blikely\b|\bestimated\b|\bTBD\b|\bmay\b|\bmight\b|\bprobably\b)/iu
/** 责任主体标记（保护项）。 */
const OWNER = /(负责|牵头|责任人|由.{0,10}(?:负责|牵头|承办|跟进)|待办|跟进人|\bowner\b|\baction item\b|\bDRI\b|\bresponsible\b)/iu
/** 承诺/期限/验收标记（保护项）。 */
const COMMITMENT = /(承诺|保证|截止|期限|交付物|验收|里程碑|务必|必须于|\bby \d|\bdeadline\b|\bcommit(?:s|ted)?\b|\bdeliverable\b|\bmilestone\b)/iu
/** 例外/排除标记（保护项）。 */
const EXCEPTION = /(除.{0,12}(?:外|之外)|例外|不适用|不含|不包括|\bexcept\b|\bexcluding\b|\bother than\b)/iu

/** 引号内容（引用/术语定义）：命中这些区间不计水分。 */
export function quoteRanges(text) {
  const source = String(text ?? '')
  const ranges = []
  const pairs = [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ['《', '》']]
  for (const [open, close] of pairs) {
    let from = 0
    while (from < source.length) {
      const begin = source.indexOf(open, from)
      if (begin < 0) break
      // 半角双引号成对出现：跳过已配对的
      const inner = source.indexOf(close, begin + 1)
      if (inner < 0) break
      ranges.push([begin, inner + 1])
      from = inner + 1
    }
  }
  return ranges
}

/** 位置是否落在任一区间内。 */
export function insideRanges(position, ranges) {
  return ranges.some(([begin, end]) => position >= begin && position < end)
}

/** 抽取"数字+单位"与日期，供 B4 数值一致性使用。 */
export function extractNumbers(text) {
  const source = String(text ?? '')
  const out = []
  const pattern = /(-?\d+(?:[.,]\d+)?)\s*(%|％|元|万元|亿元|美元|USD|CNY|RMB|EUR|GBP|小时|分钟|秒|天|周|个月|人次|次|倍|件|台|个|吨|kg|g|MB|GB|ms|pcs|units?|hours?|days?|weeks?|months?|years?|times)?/giu
  for (const match of source.matchAll(pattern)) {
    const value = Number(String(match[1]).replace(/,/gu, ''))
    if (!Number.isFinite(value)) continue
    out.push({
      value,
      unit: (match[2] ?? '').toLowerCase(),
      text: match[0].trim(),
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return out
}

/** 汇总度量。 */
export function computeStats(text) {
  const source = String(text ?? '')
  const sentences = splitSentences(source)
  const paragraphs = splitParagraphs(source)
  const cjkChars = (source.match(CJK_GLOBAL) ?? []).length
  const latinWords = (source.match(LATIN_WORD) ?? []).length
  const charsNoSpace = source.replace(/\s/gu, '').length
  const headings = (source.match(/^#{1,6}\s+\S/gmu) ?? []).length
  const listItems = (source.match(/^\s*(?:[-*+•]|\d{1,2}[.)])\s+\S/gmu) ?? []).length
  const boldChars = (source.match(/\*\*[^*\n]{1,200}\*\*/gu) ?? []).reduce((sum, item) => sum + item.length, 0)
  const numbers = extractNumbers(source)

  // ★ 标题与表格行不计入"实质信息"的分母。
  //   标题没有数字是正常的（它是指路牌，不是论点）；表格行本身就是数据载体，
  //   再要求它有"事实锚点"是同义反复。
  //   把它们混进分母，会让**每一份有层级标题的报告**都白白被压低信息密度 ——
  //   这是真实文件实测出来的误报：一份 291 字的方案里，4 条 B2 命中里有 3 条是标题。
  const contentSentences = sentences.filter(item => {
    const body = item.text.trim()
    return !/^#{1,6}\s/u.test(body) && !/^\|/u.test(body)
  })
  const ratioBase = contentSentences.length

  const factSentences = contentSentences.filter(item =>
    FACT_NUMBER.test(item.text) || FACT_DATE.test(item.text) || FACT_UNIT.test(item.text) || MECHANISM.test(item.text)).length
  const datedSentences = contentSentences.filter(item => FACT_DATE.test(item.text)).length

  return {
    chars: source.length,
    charsNoSpace,
    cjkChars,
    latinWords,
    paragraphs: paragraphs.length,
    sentences: sentences.length,
    headings,
    listItems,
    boldChars,
    numbers: numbers.length,
    dates: (source.match(/(?:(?:19|20)\d{2}\s*年)|(?:\d{1,2}\s*月\s*\d{1,2}\s*日)|(?:\d{4}\s*[-/]\s*\d{1,2})/gu) ?? []).length,
    avgSentenceChars: sentences.length === 0 ? 0 : Math.round(charsNoSpace / sentences.length),
    factSentenceRatio: ratioBase === 0 ? 0 : factSentences / ratioBase,
    datedSentenceRatio: ratioBase === 0 ? 0 : datedSentences / ratioBase,
  }
}

/**
 * 边界语句 —— 明确排除某选项、限定范围、或声明"不是什么"。
 *
 * 为什么要**硬**保护（而不是像普通否定那样只做软保护）：
 *   压缩里最危险的一类错误是把"不做什么"压成"做什么"。
 *   实例：「不直接铺大众电商」「而非万能诊断仪」「暂不进入规模推广」——
 *   这三句一旦被删，摘要就从"有边界的方案"变成"无条件的承诺"，而字数上完全看不出来。
 *   普通否定词（"不"）频率太高，硬保护会让提炼退化成照抄；
 *   但"而非 / 暂不 / 仅限 / 只做 / 不包括"这类**成句的边界判断**频率低、信息密度高，
 *   漏一句就是语义反转，所以单独拎出来做硬保护。
 */
const BOUNDARY_CLAIM = /(而非|而不是|并非|暂不|不做|不进入|不铺|不承诺|不包括|不覆盖|不涉及|仅限|仅限于|只做|只用于|仅在|除此之外|唯一例外)/u

/**
 * 主体归属 —— 句子的主语是不是第三方。
 *
 * 用来防止把"政府支持某展会"提炼成作者的态度、"竞品去年上线了某功能"提炼成本项目的待办。
 * 历史事实与第三方动作可以进「阐述」，不应进「态度」与「执行」。
 */
const THIRD_PARTY_SUBJECT = /^(?:据|按照|根据)?\s*(?:政府|官方|平台|渠道|客户|用户|竞品|对手|供应商|厂商|第三方|行业|媒体|协会|展会|Amazon|亚马逊|eBay|Walmart|Shopify|TikTok|AliExpress)/u

/**
 * 中文数量表述 —— 阿拉伯数字之外的第二套数字。
 *
 * 中文商务文档里，时点与量级大量用汉字写：「第五个月进入规模推广」「三千万预算」
 * 「两个月内完成」。只认 `\d` 的保护项，对这类句子是完全失明的 —— 实测出现过
 * 「该市场全面铺开，第五个月进入规模推广。」这种**带着时间承诺的结论句**
 * 在提炼里被当成普通句子丢掉。
 *
 * 只认"数量词 + 计量单位"，不认孤立的汉字数字：否则「一定」「万一」「十分满意」
 * 都会被卷进来，保护项立刻失效（全都保护 = 全都不保护）。
 */
const CHINESE_QUANTITY = /第?[一二三四五六七八九十百千万亿两]{1,4}(?:个?月|个?季度|个?周|天|年|万元|亿元|元|美元|%|％|倍|台|件|人次|次|人)/u

/** 句子的"保护项"档案 —— 提炼时强制保留的依据。 */
export function protectionProfile(sentenceText) {
  const text = String(sentenceText ?? '')
  const flags = []
  if (FACT_NUMBER.test(text)) flags.push('number')
  if (FACT_DATE.test(text)) flags.push('date')
  if (NEGATION.test(text)) flags.push('negation')
  if (CONDITION.test(text)) flags.push('condition')
  if (UNCERTAIN.test(text)) flags.push('uncertainty')
  if (OWNER.test(text)) flags.push('owner')
  if (COMMITMENT.test(text)) flags.push('commitment')
  if (EXCEPTION.test(text)) flags.push('exception')
  if (BOUNDARY_CLAIM.test(text)) flags.push('boundary')
  if (THIRD_PARTY_SUBJECT.test(text)) flags.push('third-party')
  return flags
}

/**
 * 硬保护项：只要命中就必须进提炼结果（任何压缩档位都不得丢）。
 *
 * 为什么"否定/条件/不确定性"不算硬保护：
 *   它们在中文里出现频率极高（"不"、"若"），若都算硬保护，提炼会退化成全文照抄。
 *   这三类改为**软保护**：句子若被选中就整句保留，绝不改写半句；
 *   同时由 `fidelityCheck()` 比对候选句与入选句，把漏掉的软保护项显式报出来。
 */
export function hardProtection(sentenceText) {
  const text = String(sentenceText ?? '')
  // 数字必须"有分量"：单位、或 ≥2 位、或带小数点 —— 单个"3 个"不足以强制保留
  const meaningfulNumber = /-?\d+(?:[.,]\d+)?\s*(%|％|元|万元|亿元|美元|USD|CNY|RMB|EUR|GBP|小时|分钟|秒|天|周|个月|人次|次|倍|件|台|吨|kg|MB|GB|ms|pcs|units?|hours?|days?|weeks?|months?|years?|times)/iu.test(text)
    || /-?\d{2,}/u.test(text)
    || /-?\d+\.\d+/u.test(text)
    // 汉字写的数量同样算"有分量的数"：只认阿拉伯数字会让中文商务文档整体失明
    || CHINESE_QUANTITY.test(text)
  const flags = []
  if (meaningfulNumber) flags.push('number')
  if (FACT_DATE.test(text)) flags.push('date')
  if (OWNER.test(text)) flags.push('owner')
  if (COMMITMENT.test(text)) flags.push('commitment')
  if (CONDITION.test(text) && /(则|就|便|→|=>|，)/u.test(text)) flags.push('conditional-outcome')
  // 边界语句一律硬保护：删掉它，语义会从"有边界"反转成"无边界"，而字数上毫无痕迹。
  if (BOUNDARY_CLAIM.test(text)) flags.push('boundary')
  return flags
}

/** 去标点的纯内容序列（用于重复检测）。 */
export function contentSequences(text) {
  const source = String(text ?? '')
  const cjk = source.replace(/[^\u3400-\u4dbf\u4e00-\u9fff]/gu, '')
  const latin = (source.toLowerCase().match(/[a-z]{2,}/gu) ?? [])
  return { cjk, latin }
}

/**
 * 重复检测：找出被重复使用的 n-gram 覆盖了哪些内容位置。
 * 返回 { removedChars, units } —— units 是被重复的片段（去重后前若干条）。
 */
export function findRepetition(text, { cjkGram = 8, latinGram = 6, maxUnits = 20 } = {}) {
  const { cjk, latin } = contentSequences(text)
  const units = []
  let removedChars = 0

  const scan = (sequence, gram) => {
    if (sequence.length < gram * 2) return 0
    const counts = new Map()
    for (let at = 0; at + gram <= sequence.length; at += 1) {
      const key = sequence.slice(at, at + gram)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const repeated = new Set()
    for (const [key, count] of counts) if (count >= 2) repeated.add(key)
    if (repeated.size === 0) return 0

    // 标记被"重复片段"覆盖的位置：同一片段在第 2 次及以后的出现算水分
    const covered = new Uint8Array(sequence.length)
    const seen = new Map()
    for (let at = 0; at + gram <= sequence.length; at += 1) {
      const key = sequence.slice(at, at + gram)
      if (!repeated.has(key)) continue
      const prior = seen.get(key) ?? 0
      seen.set(key, prior + 1)
      if (prior === 0) continue            // 首次出现不算重复
      for (let offset = 0; offset < gram; offset += 1) covered[at + offset] = 1
      if (units.length < maxUnits) units.push(key)
    }
    let total = 0
    for (const flag of covered) total += flag
    return total
  }

  removedChars += scan(cjk, cjkGram)
  removedChars += scan(latin, latinGram)

  // 片段去重（保留首次出现顺序）
  const unique = []
  const seenUnits = new Set()
  for (const unit of units) {
    if (seenUnits.has(unit)) continue
    seenUnits.add(unit)
    unique.push(unit)
  }
  return { removedChars, units: unique.slice(0, maxUnits) }
}

/** 字符 bigram 集合（用于相邻句相似度）。 */
export function bigramSet(text) {
  const compact = String(text ?? '').replace(/\s/gu, '')
  const out = new Set()
  for (let at = 0; at + 2 <= compact.length; at += 1) out.add(compact.slice(at, at + 2))
  return out
}

/** Jaccard 相似度。 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * 在原文里按偏移定位，返回可读坐标（面板与报告都用它）。
 *
 * ★ 单槽缓存：一次体检里所有命中都属于同一份文本，逐条线性数换行是 O(n·hits)，
 *   在 60 万字的报告上会明显卡住。这里缓存"上一份文本的行首下标表"，命中定位降到 O(log n)。
 *   只缓存一份 —— 分析完换下一份文件时自然替换，不会在长驻进程里攒内存。
 */
let cachedText = null
let cachedLineStarts = null

export function locate(text, start) {
  const source = String(text ?? '')
  if (source !== cachedText) {
    const starts = [0]
    for (let at = 0; at < source.length; at += 1) {
      if (source[at] === '\n') starts.push(at + 1)
    }
    cachedText = source
    cachedLineStarts = starts
  }
  const safe = Math.max(0, Math.min(start, source.length))
  const starts = cachedLineStarts
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (starts[mid] <= safe) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: safe - starts[low] + 1 }
}
