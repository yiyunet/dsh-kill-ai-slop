// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/distill.mjs
/**
 * 五要素提炼 —— 从第一性原理把文件压成"目的 / 阐述 / 观点 / 态度 / 执行"。
 *
 * ★ 本项目最重要的一条设计决定：**抽取式，不改写**。
 *   原设计是"保真校验失败 → 退回抽取式"，而实测里"校验"本身并不可靠
 *   （没有任何本地规则能证明一句改写后的话与原意等价）。所以这里干脆**不做改写**：
 *   每一句输出都是原文的连续片段，`start/end` 可回原文逐字核对。
 *   代价是读起来不如人写的摘要顺；收益是**永远不会把"预计降本"写成"可以降本"**。
 *   这个取舍是刻意的，改了它这套东西就不成立了。
 *
 * ★ 保护项（数字/日期/责任/承诺/条件结论）**强制入选**：
 *   只要一句命中硬保护项，它就必须出现在任何压缩档位里 ——
 *   保真不是靠事后比对发现的，是靠结构保证的。
 */

import {
  ACTION_MARK,
  CLAIM,
  EVIDENCE,
  OWNER_MARK,
  PURPOSE_MARK,
  PURPOSE_SPECIFIC,
  TEMPLATE_SUMMARY,
  TEMPLATE_TURN,
  VACUOUS_CJK,
  VACUOUS_EN,
  TIME_MARK,
} from './rules.mjs'
import { hardProtection, locate, protectionProfile, splitParagraphs, splitSentences } from './text.mjs'

/** 三个压缩档位。 */
export const LEVELS = [
  {
    id: 'integrity',
    label: '保真精简',
    desc: '保留原文结构与顺序，只删纯套话与重复句；删了什么逐条列出。',
  },
  {
    id: 'summary',
    label: '工作摘要',
    desc: '按五要素重组，全部为原句摘录；适合拿去做决定或派活。',
  },
  {
    id: 'card',
    label: '速读卡片',
    desc: '每要素最多 3 条，只够快速了解；**不能替代完整文件**。',
  },
]

export const STANCES = ['支持', '反对', '建议', '保留', '尚未判断', '未表态']

const STANCE_PATTERNS = [
  { value: '反对', pattern: /(反对|不赞成|不同意|拒绝|不建议|不可行|反对意见|reject|oppose|do not recommend|don't recommend)/iu },
  { value: '保留', pattern: /(保留意见|有疑虑|存疑|待观察|谨慎|担忧|顾虑|风险较大|reservations|concerns|hesitant)/iu },
  { value: '尚未判断', pattern: /(尚未判断|待评估|未能判断|尚无结论|暂不结论|进一步评估|undetermined|pending evaluation|not yet decided)/iu },
  { value: '建议', pattern: /(建议|提议|推荐|应当|宜|recommend|propose|suggest|should)/iu },
  { value: '支持', pattern: /(支持|赞成|同意|认可|批准|approve|support|endorse|agree)/iu },
]

/**
 * 决策主张 —— 明确取舍或排序的句子。
 *
 * 为什么要与 CLAIM 分开：`CLAIM` 里全是「因此 / 表明 / 说明 / 建议」这类**论证连接词**，
 * 而「PartsTech 是最佳首选渠道，应优先接洽。」一个连接词都没有 —— 却恰恰是全篇最该被提炼出来的一句。
 *
 * 实测后果：它既不符合「事实/数据」的入选条件（没有数字锚点），也不符合「观点」的（没有论证连接词），
 * 于是**根本没进入任何候选池**，连参与排序的机会都没有。
 * 摘要因此保住了表格碎片 `| PartsTech | P2 |`，却丢掉了唯一的决断 —— 这是最坏的一种失败。
 *
 * 观点一节的职责是"作者作出了什么判断"。取舍与排序本身就是最强的一种判断，
 * 判断力不该只在有连接词的时候才算数。
 */
const DECISION_CLAIM = /(首选|优先|先做|先行|暂缓|缓做|定为|选定|采纳|放弃|不做|暂不|决定|取舍|推荐|建议选|本轮先|首轮先)/u

/** 纯套话句：整句除了套话词与虚词，没有别的内容 —— 精简档可删。 */
function isBoilerplateSentence(text) {
  const trimmed = String(text ?? '').trim()
  // ★ 标题不是套话句。
  //   "## 四、风险"被机器按"去掉虚词后只剩 4 个字"判成纯套话，理由是
  //   "删去不损失事实/判断/语境" —— 这句话对标题根本不成立：删掉它，读者就丢了结构。
  //   标题该不该删是结构问题，不是套话问题，不该走这条判据。
  if (/^#{1,6}\s/u.test(trimmed)) return false
  // 表格分隔行（|---|---|）是排版符号，没有任何内容
  if (/^\|?[\s\-:|]+\|?$/u.test(trimmed)) return true
  if (trimmed.length < 6) return true
  let stripped = trimmed
  for (const word of VACUOUS_CJK) stripped = stripped.split(word).join('')
  for (const word of VACUOUS_EN) stripped = stripped.replace(new RegExp(word, 'giu'), '')
  stripped = stripped
    .replace(TEMPLATE_TURN, '')
    .replace(TEMPLATE_SUMMARY, '')
    .replace(/[，。！？、；：""''（）\s,.!?;:()]/gu, '')
  return stripped.length <= 6
}

/** 句子是否有事实锚点。 */
function hasFactAnchor(text) {
  return /\d/u.test(text)
    || /(%|％|元|万元|亿元|小时|分钟|次|倍|件|台|吨|USD|CNY|EUR|GBP)/iu.test(text)
    || /((?:19|20)\d{2}\s*[年\-/])|(\d{1,2}\s*月\s*\d{1,2}\s*日)/u.test(text)
}

/** 句子"信息量"打分（只用于排序取舍，不对外作为质量分）。 */
function informativeness(sentenceText) {
  let score = 0
  if (hasFactAnchor(sentenceText)) score += 3
  if (EVIDENCE.test(sentenceText)) score += 2
  if (CLAIM.test(sentenceText)) score += 1
  // 决策句是工作文档里最值钱的一句：它决定了后面所有动作往哪走。给高过普通主张。
  if (DECISION_CLAIM.test(sentenceText)) score += 2
  if (OWNER_MARK.test(sentenceText) || TIME_MARK.test(sentenceText)) score += 2
  if (TEMPLATE_TURN.test(sentenceText) || TEMPLATE_SUMMARY.test(sentenceText)) score -= 1
  if (isBoilerplateSentence(sentenceText)) score -= 3
  // ★ 表格行是数据碎片，不是论点句。
  //   让它们和正文判断句同池竞争，实测结果是：
  //   「| PartsTech | P2 |」被选中，而「PartsTech 是最佳首选渠道，应优先接洽。」被丢掉 ——
  //   摘要保住了表格碎片，却丢了全文唯一一句决断。这比压缩比难看严重得多。
  if (/^\s*\|/u.test(String(sentenceText ?? ''))) score -= 4
  score += Math.min(3, Math.floor(sentenceText.length / 40))
  return score
}

/** 建句库（带全局偏移与保护档案）。 */
function buildSentences(text) {
  const out = []
  for (const paragraph of splitParagraphs(text)) {
    for (const sentence of splitSentences(paragraph.text)) {
      const start = paragraph.start + sentence.start
      const end = paragraph.start + sentence.end
      out.push({
        text: sentence.text,
        start,
        end,
        line: locate(text, start).line,
        hard: hardProtection(sentence.text),
        soft: protectionProfile(sentence.text),
        weight: informativeness(sentence.text),
        boilerplate: isBoilerplateSentence(sentence.text),
      })
    }
  }
  return out
}

const quoteOf = sentence => ({
  text: sentence.text,
  start: sentence.start,
  end: sentence.end,
  line: sentence.line,
})

/** 目的。 */
function distillPurpose(sentences) {
  // 只在前 25%（至少 3 句）里找目的句：目的写在第三段之后的文件，本身就说明问题。
  const headLimit = Math.max(3, Math.ceil(sentences.length * 0.25))
  const candidate = sentences.slice(0, headLimit).find(sentence => PURPOSE_MARK.test(sentence.text))
  if (candidate === undefined) {
    return {
      status: '未明示',
      conclusion: '原文前段没有陈述目的或期待的动作 —— 这是接收者最先缺的东西。',
      quotes: [],
    }
  }
  const specific = PURPOSE_SPECIFIC.test(candidate.text)
  return {
    status: specific ? '明示' : '推断',
    conclusion: specific
      ? '原文明确写出目的，并指向具体动作（决定/审批/确认）。'
      : '原文提到目的，但停在"介绍"层面，没有指向要读者做的动作 —— 按"推断"处理。',
    quotes: [quoteOf(candidate)],
  }
}

/** 阐述（对象、背景、关键事实与机制）。 */
function distillExposition(sentences, limit) {
  return sentences
    .filter(sentence => !sentence.boilerplate)
    .filter(sentence => hasFactAnchor(sentence.text) || EVIDENCE.test(sentence.text) || /(指的是|定义为|包括|由.{0,8}(?:组成|构成)|背景|现状|约束|前提)/u.test(sentence.text))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .sort((a, b) => a.start - b.start)
    .map(sentence => ({
      kind: hasFactAnchor(sentence.text) ? '事实/数据' : '背景/机制',
      ...quoteOf(sentence),
      hasEvidence: EVIDENCE.test(sentence.text),
    }))
}

/**
 * 结构元素：标题与表格行。
 *
 * 它们不是"句子"，是路标与数据载体，**不得进入任何语义池**（观点 / 态度 / 执行）。
 *
 * 为什么必须单独有这个闸：0.2.1 为修 F26 把标题从"纯套话"里放了出来，
 * 副作用是它们从此可以进任何池子 —— 于是 `## 二、渠道优先级` 因含"优先"被当成决策主张，
 * `| 渠道 | 优先级 |` 被当成表头主张，双双出现在「观点」里。
 *
 * 这跟 B2 把标题当论证句是**同一个错的两个出口**：修了一处，另一处还在漏。
 * 所以给它一个统一的名字，三个池子共用同一道闸。
 */
function isStructural(text) {
  const body = String(text ?? '').trim()
  return /^#{1,6}\s/u.test(body) || /^\|/u.test(body)
}

/** 观点（主张、结论、建议及依据）。 */
function distillClaims(sentences, limit) {
  return sentences
    .filter(sentence => (CLAIM.test(sentence.text) || DECISION_CLAIM.test(sentence.text))
      && !sentence.boilerplate
      && !isStructural(sentence.text))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .sort((a, b) => a.start - b.start)
    .map(sentence => ({
      ...quoteOf(sentence),
      support: EVIDENCE.test(sentence.text) ? '同句有依据标记' : '同句无依据标记 · 需追问',
    }))
}

/** 态度（明确表态 / 未表态，不读心）。 */
function distillStance(sentences) {
  const found = []
  for (const stance of STANCE_PATTERNS) {
    const sentence = sentences.find(item => stance.pattern.test(item.text) && !item.boilerplate && !isStructural(item.text))
    if (sentence !== undefined) found.push({ value: stance.value, quote: quoteOf(sentence) })
  }
  if (found.length === 0) {
    return {
      value: '未表态',
      conclusion: '原文没有可识别的表态句 —— 按"未表态"处理，不推测立场。',
      quotes: [],
      alternatives: [],
    }
  }
  return {
    value: found[0].value,
    conclusion: `识别到 ${found.length} 种表态：${found.map(item => item.value).join(' / ')}；以最强的一种（${found[0].value}）为首要态度。`,
    quotes: found.map(item => item.quote),
    alternatives: found.map(item => item.value),
  }
}

/** 执行（动作、责任人、交付物、期限、验收、依赖）。 */
function distillActions(sentences, limit) {
  const actions = []
  for (const sentence of sentences) {
    if (!ACTION_MARK.test(sentence.text) || sentence.boilerplate || isStructural(sentence.text)) continue
    const ownerMatch = OWNER_MARK.exec(sentence.text)
    const timeMatch = TIME_MARK.exec(sentence.text)
    actions.push({
      action: sentence.text,
      start: sentence.start,
      end: sentence.end,
      line: sentence.line,
      owner: ownerMatch === null ? '未说明' : ownerMatch[0].trim(),
      due: timeMatch === null ? '未说明' : timeMatch[0].trim(),
      status: ownerMatch !== null && timeMatch !== null
        ? '已写明'
        : (ownerMatch === null && timeMatch === null ? '责任人与期限均未说明' : (ownerMatch === null ? '缺责任人' : '缺期限')),
    })
    if (actions.length >= limit) break
  }
  return actions
}

/** 证据与限制。 */
function distillEvidenceAndLimits(sentences, limit) {
  const out = []
  for (const sentence of sentences) {
    if (sentence.boilerplate) continue
    const kinds = []
    if (EVIDENCE.test(sentence.text)) kinds.push('依据')
    if (/(假设|前提|仅在|如果|若|除非|前提是|assumption|assuming|provided)/iu.test(sentence.text)) kinds.push('假设/前提')
    if (/(尚未|待|未验证|无数据|尚无|不确定|估计|预计|可能|limitation|limitations|not tested|unknown)/iu.test(sentence.text)) kinds.push('限制/未验证')
    if (kinds.length === 0) continue
    out.push({ kinds, ...quoteOf(sentence) })
    if (out.length >= limit) break
  }
  return out
}

/**
 * 提炼主入口。
 * @param {string} text 规范文本
 * @param {{level?: string, extraQuestions?: string[]}} [options]
 */
export function distill(text, options = {}) {
  const level = LEVELS.some(item => item.id === options.level) ? options.level : 'summary'
  const source = String(text ?? '')
  const sentences = buildSentences(source)

  const hardUnits = sentences.filter(sentence => sentence.hard.length > 0)
  const softUnits = sentences.filter(sentence => sentence.soft.length > 0)

  const limits = level === 'card' ? 3 : (level === 'summary' ? 12 : 40)

  const purpose = distillPurpose(sentences)
  const exposition = distillExposition(sentences, limits)
  const claims = distillClaims(sentences, limits)
  const stance = distillStance(sentences)
  const actions = distillActions(sentences, limits)
  const evidenceAndLimits = distillEvidenceAndLimits(sentences, limits)

  // ── 选取（按档位）────────────────────────────────────────────────
  let selected
  if (level === 'integrity') {
    // 保真精简：整篇顺序保留，只删"纯套话"与完全重复句；硬保护项一律保留
    const seen = new Set()
    selected = []
    for (const sentence of sentences) {
      const fingerprint = sentence.text.replace(/\s/gu, '')
      const duplicated = seen.has(fingerprint)
      seen.add(fingerprint)
      if (sentence.hard.length > 0) {
        selected.push(sentence)
        continue
      }
      if (sentence.boilerplate) continue
      if (duplicated) continue
      selected.push(sentence)
    }
  } else if (level === 'summary') {
    const keep = new Set()
    for (const sentence of sentences.slice(0, 3)) keep.add(sentence)          // 开头往往就是目的
    for (const sentence of hardUnits) keep.add(sentence)
    for (const item of exposition) keep.add(sentences.find(s => s.start === item.start))
    for (const item of claims) keep.add(sentences.find(s => s.start === item.start))
    for (const item of actions) keep.add(sentences.find(s => s.start === item.start))
    for (const item of evidenceAndLimits) keep.add(sentences.find(s => s.start === item.start))
    if (purpose.quotes[0] !== undefined) keep.add(sentences.find(s => s.start === purpose.quotes[0].start))
    selected = [...keep].filter(Boolean).sort((a, b) => a.start - b.start)
  } else {
    const capped = new Set()
    for (const sentence of hardUnits) capped.add(sentence)
    for (const item of exposition.slice(0, 3)) capped.add(sentences.find(s => s.start === item.start))
    for (const item of claims.slice(0, 3)) capped.add(sentences.find(s => s.start === item.start))
    for (const item of actions.slice(0, 3)) capped.add(sentences.find(s => s.start === item.start))
    if (purpose.quotes[0] !== undefined) capped.add(sentences.find(s => s.start === purpose.quotes[0].start))
    selected = [...capped].filter(Boolean).sort((a, b) => a.start - b.start)
  }

  // 用 Set 做成员判定：句子数上千时，Array.includes 的 O(n²) 会明显拖慢
  const selectedSet = new Set(selected)
  const dropped = sentences.filter(sentence => !selectedSet.has(sentence))

  // ── 保真校验：硬保护项必须 100% 在场 ──────────────────────────────
  const keptHardUnits = hardUnits.filter(sentence => selectedSet.has(sentence))
  const lostHardRules = []
  for (const rule of ['number', 'date', 'owner', 'commitment', 'conditional-outcome']) {
    const total = sentences.filter(sentence => sentence.hard.includes(rule)).length
    const kept = keptHardUnits.filter(sentence => sentence.hard.includes(rule)).length
    if (kept < total) lostHardRules.push({ rule, total, kept })
  }

  const fidelity = {
    ok: lostHardRules.length === 0,
    hardUnitCount: hardUnits.length,
    hardUnitKept: keptHardUnits.length,
    lost: lostHardRules,
    softUnitCount: softUnits.length,
    note: lostHardRules.length === 0
      ? `硬保护项 ${hardUnits.length} 句（数字/日期/责任人/承诺/条件结论/**边界表述**）全部保留。`
      : `⚠️ 有 ${hardUnits.length - keptHardUnits.length} 句硬保护项未进入结果 —— 提炼不可用，请改用「保真精简」并人工复核。`,
  }

  // ── 必须追问 ─────────────────────────────────────────────────────
  const questions = []
  if (purpose.status === '未明示') questions.push('这份文件要你做什么决定或动作？请对方用一句话写清。')
  if (purpose.status === '推断') questions.push('目的句没写要读者做什么 —— 需要审批、确认，还是只要知会？')
  if (actions.length === 0) questions.push('这份文件里有需要执行的动作吗？若有，谁做、什么时候交？')
  const missingOwner = actions.filter(action => action.owner === '未说明')
  if (missingOwner.length > 0) questions.push(`${missingOwner.length} 条动作没有责任人 —— 谁负责？`)
  const missingDue = actions.filter(action => action.due === '未说明')
  if (missingDue.length > 0) questions.push(`${missingDue.length} 条动作没有期限 —— 什么时候要？`)
  const unsupported = claims.filter(claim => claim.support !== '同句有依据标记')
  if (unsupported.length > 0) questions.push(`${unsupported.length} 条主张同句内无依据 —— 依据是什么？请给出可核来源。`)
  if (stance.value === '未表态') questions.push('对方的态度没写出来 —— 是支持、反对，还是还没判断？')
  if (level === 'card') questions.push('本卡片只够快速了解，做决定前请回到完整文件核对原文。')
  for (const extra of options.extraQuestions ?? []) questions.push(extra)

  return {
    level,
    levelLabel: LEVELS.find(item => item.id === level).label,
    levelDesc: LEVELS.find(item => item.id === level).desc,
    method: '抽取式（每一句都是原文片段，未做任何改写）',
    elements: {
      purpose: { label: '目的', ...purpose },
      exposition: { label: '阐述', items: exposition },
      claims: { label: '观点', items: claims },
      stance: { label: '态度', ...stance },
      actions: { label: '执行', items: actions },
    },
    evidenceAndLimits,
    questions: [...new Set(questions)],
    protectedUnits: {
      total: hardUnits.length,
      kept: keptHardUnits.length,
      rules: ['number', 'date', 'owner', 'commitment', 'conditional-outcome'],
      softTotal: softUnits.length,
    },
    fidelity,
    compression: {
      sentencesTotal: sentences.length,
      sentencesKept: selected.length,
      droppedCount: dropped.length,
      ratio: sentences.length === 0 ? 0 : Number((selected.length / sentences.length).toFixed(3)),
      dropped: dropped.slice(0, 40).map(sentence => ({
        text: sentence.text.length > 80 ? `${sentence.text.slice(0, 77)}…` : sentence.text,
        line: sentence.line,
        why: sentence.boilerplate ? '纯套话句（删去不损失事实/判断/语境）' : '未被选入（信息量排序靠后，且不含硬保护项）',
      })),
      droppedTruncated: dropped.length > 40,
    },
    sentences: selected.map(quoteOf),
    text: source,
  }
}

/**
 * 把提炼结果渲染成 Markdown（面板与工具共用同一份渲染）。
 * @param {object} result distill() 的返回
 * @param {{headingLevel?: number}} [options] 起始标题层级：独立输出用 2，嵌进报告用 3
 */
export function renderDistillMarkdown(result, options = {}) {
  const level = Math.min(6, Math.max(1, Number(options.headingLevel ?? 2)))
  const h = n => '#'.repeat(Math.min(6, level + n))

  const lines = []
  lines.push(`${h(0)} 提炼结果 · ${result.levelLabel}`)
  lines.push('')
  lines.push(`> 方法：${result.method}。${result.levelDesc}`)
  lines.push('')

  const section = (title, body) => {
    lines.push(`${h(1)} ${title}`)
    lines.push('')
    lines.push(body)
    lines.push('')
  }

  const purpose = result.elements.purpose
  section('① 目的', purpose.quotes.length === 0
    ? `**未明示**。${purpose.conclusion}`
    : `**${purpose.status}**。${purpose.conclusion}\n\n> ${purpose.quotes.map(item => `第 ${item.line} 行：「${item.text}」`).join('\n> ')}`)

  section('② 阐述（对象 / 背景 / 关键事实）', result.elements.exposition.items.length === 0
    ? '原文没有可摘出的事实或背景句 —— 这是缺口，不是"没有背景需要交代"。'
    : result.elements.exposition.items.map(item => `- 〔${item.kind}·第 ${item.line} 行〕${item.text}`).join('\n'))

  section('③ 观点（主张 / 结论 / 建议）', result.elements.claims.items.length === 0
    ? '原文没有可识别的主张句。'
    : result.elements.claims.items.map(item => `- 〔第 ${item.line} 行 · ${item.support}〕${item.text}`).join('\n'))

  const stance = result.elements.stance
  section('④ 态度', `**${stance.value}**。${stance.conclusion}`
    + (stance.quotes.length === 0 ? '' : `\n\n> ${stance.quotes.map(item => `第 ${item.line} 行：「${item.text}」`).join('\n> ')}`))

  section('⑤ 执行（动作 / 责任人 / 期限）', result.elements.actions.items.length === 0
    ? '原文没有动作类要求 —— 若这是方案或计划，本身就缺执行段。'
    : result.elements.actions.items.map(item =>
      `- 〔${item.status}〕${item.action}\n  - 责任人：${item.owner}｜期限：${item.due}｜第 ${item.line} 行`).join('\n'))

  section('证据与限制', result.evidenceAndLimits.length === 0
    ? '原文没有标注依据、假设或限制 —— 结论强度无法判断。'
    : result.evidenceAndLimits.map(item => `- 〔${item.kinds.join(' / ')}·第 ${item.line} 行〕${item.text}`).join('\n'))

  section('必须追问', result.questions.length === 0 ? '无（各要素均已写明）。' : result.questions.map((item, index) => `${index + 1}. ${item}`).join('\n'))

  section('保真与压缩', [
    `- 保真：${result.fidelity.note}`,
    `- 压缩：${result.compression.sentencesTotal} 句 → ${result.compression.sentencesKept} 句（保留 ${(result.compression.ratio * 100).toFixed(0)}%），删去 ${result.compression.droppedCount} 句。`,
    '',
    '**删了什么**（前 40 条）：',
    ...result.compression.dropped.map(item => `- 第 ${item.line} 行：${item.text} —— ${item.why}`),
    ...(result.compression.droppedTruncated ? ['- …（其余省略）'] : []),
  ].join('\n'))

  return lines.join('\n')
}
