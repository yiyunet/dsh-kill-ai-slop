/**
 * 规则集 —— 双指数 11 个维度的判定逻辑。
 *
 * ★ 三条纪律（对三个上游开源件的吸纳）：
 *   ① 命中是**线索**不是判决：每条命中必须带原文片段、为什么、以及怎么改；
 *   ② 词面只作**弱信号**：单个套话词不构成高分，靠"命中数 + 密度"升级严重度；
 *   ③ 引号内是**引用/术语**，一律不计水分 —— 否则会惩罚"如实引用对方原话"的好文档。
 *
 * ★ 三态必须分清（这是本方法的硬约束）：
 *     not-applicable（不适用，退出分母）≠ insufficient（未能评估，退出分母）≠ 0（已评估无问题）
 *   三者混用会让"我没看"变成"没问题"，这是本插件最不能犯的错。
 */

import {
  bigramSet,
  computeStats,
  findRepetition,
  insideRanges,
  jaccard,
  locate,
  quoteRanges,
  splitParagraphs,
  splitSentences,
} from './text.mjs'

/** 规则集版本 —— 规则/权重/阈值任一改动必须换版本，新旧分数不直接可比。 */
export const RULESET_VERSION = 'slop-rules/0.7.17'

/**
 * 这套规则是为哪个引擎版本构建的。
 *
 * ★ 为什么要有这个字段：热重载只重新导入**改动过的文件**，于是可能出现
 *   「新 audit.mjs + 旧 rules.mjs」的混装 —— 报告上写着新版本号，实际用它算分的是旧规则。
 *   这种状态**不会报任何错**，只会安静地给出错分，是本插件最难被发现的一类故障。
 *   audit.mjs 用它做一致性闸门：对不上就拒绝出分并让人重启。
 */
export const RULESET_ENGINE = '0.7.17'

/** 两个指数（都 0–100，越高问题越重；都不是概率）。 */
export const INDICES = {
  A: {
    id: 'A',
    label: '表达水分分',
    question: '多少表达成本没有转化成信息',
    role: '辅助指标：判文风是否在制造阅读成本',
  },
  B: {
    id: 'B',
    label: '工作空转分',
    question: '是否把本该完成的思考与整理转嫁给了接收者',
    role: '主指标：工作文档先看这条',
  },
}

/**
 * 维度与初始权重。
 * ⚠️ 权重是 **初案（未经校准）**，不是标准。首个真实盲测后才回写实测值。
 */
export const DIMENSIONS = [
  { id: 'A1', index: 'A', label: '空话与套话', weight: 25 },
  { id: 'A2', index: 'A', label: '信息重复', weight: 25 },
  { id: 'A3', index: 'A', label: '模板化表达', weight: 20 },
  { id: 'A4', index: 'A', label: '模糊与夸大', weight: 20 },
  { id: 'A5', index: 'A', label: '段落推进', weight: 10 },
  { id: 'B1', index: 'B', label: '目的陈述', weight: 15 },
  { id: 'B2', index: 'B', label: '实质信息', weight: 20 },
  { id: 'B3', index: 'B', label: '论据支撑', weight: 20 },
  { id: 'B4', index: 'B', label: '逻辑一致性', weight: 20 },
  { id: 'B5', index: 'B', label: '决策支持', weight: 10 },
  { id: 'B6', index: 'B', label: '执行完整性', weight: 15 },
]

/** 文档类型 —— 是**适用性开关**，不是风格偏好。 */
export const DOC_TYPES = [
  { id: 'auto', label: '自动判断' },
  { id: 'proposal', label: '方案 / 提案' },
  { id: 'plan', label: '计划 / 排期' },
  { id: 'report', label: '报告 / 汇报' },
  { id: 'minutes', label: '会议纪要' },
  { id: 'research', label: '研究 / 调研' },
  { id: 'explainer', label: '说明 / 科普' },
  { id: 'notice', label: '通知 / 公告' },
  { id: 'generic', label: '其他 / 不确定' },
]

/** 维度不适用的处方式说明（写清"为什么不适用"，不静默退出）。 */
const NOT_APPLICABLE = {
  minutes: {
    B3: '会议纪要靠如实记录取得价值，不承担论证义务 —— 判它"缺论据"是拿错尺子量。',
    B5: '纪要不要求给出取舍与风险分析。',
    A5: '纪要按议题并列记录，段与段之间本来就不承担推进义务 —— 用"段间无推进"量它是拿错尺子（与 B3 同理）。',
  },
  explainer: {
    B3: '说明类文档可以只陈述结论，论证义务在更上游的文件里。',
    B5: '说明类文档通常不承载取舍决策。',
    B6: '说明类文档不指派责任人，缺责任人不算缺陷。',
  },
  notice: {
    B3: '通知不承担论证义务。',
    B5: '通知不要求给出取舍与风险分析。',
    A5: '通知是并列事项清单，不承担论证推进 —— 段间无推进不算缺陷。',
  },
  research: {
    B6: '研究报告交付的是结论，不承诺执行动作。',
  },
  // ★ 这里原有一条 `generic: { B6: '未指明文档类型时，不对执行完整性扣分（避免体裁误伤）' }`，
  //   0.2.6 删了。它把**「识别失败」当成了「不适用」**：
  //     不适用   = 这类文件本来就不该有执行要求；
  //     识别失败 = 我们不知道它该不该有。
  //   实测代价很具体：一份明显是「开拓方案」的文件被 inferDocType 判成 generic，
  //   于是 B6 印「不适用」，而它本该报出「动作项若干条无责任人、无期限」——
  //   **最该被看见的一维，被静默跳过了。**
  //   现在 generic 不再拦，改走 evaluateB6 的「已观测」分支：照实数，不据此扣分。
}

/** 自动判断文档类型：只看结构信号，不猜内容。 */
export function inferDocType(text) {
  const source = String(text ?? '')
  const head = source.slice(0, 1500)
  if (/(会议纪要|会议记录|参会人|出席人|纪要|minutes of meeting|\bMoM\b)/iu.test(head)) return 'minutes'
  if (/(通知|公告|告示|notice|announcement)/iu.test(head)) return 'notice'
  if (/(方案|提案|建议书|plan of record|proposal|RFC)/iu.test(head)) return 'proposal'
  if (/(计划|排期|路线图|roadmap|schedule|timeline|milestone)/iu.test(head)) return 'plan'
  if (/(调研|研究|分析报告|白皮书|research|whitepaper|survey)/iu.test(head)) return 'research'
  if (/(汇报|报告|述职|周报|月报|report|summary of)/iu.test(head)) return 'report'
  if (/(说明|科普|介绍|指路|faq|guide|overview|explainer)/iu.test(head)) return 'explainer'
  return 'generic'
}

/* ─────────────────────────── 词表（弱信号） ──────────────────────────── */

export const VACUOUS_CJK = [
  '赋能', '抓手', '闭环', '颗粒度', '打法', '组合拳', '顶层设计', '底层逻辑',
  '全方位', '多维度', '深度融合', '持续发力', '再上台阶', '高度重视', '全面提升',
  '全面推进', '有效提升', '切实提高', '进一步增强', '充分发挥', '积极稳妥',
  '有序推进', '统筹推进', '势能', '护城河', '双向奔赴', '形成合力', '拉通', '认知升级',
]

export const VACUOUS_EN = [
  'leverage', 'synergy', 'synergistic', 'best-in-class', 'world-class', 'seamless',
  'seamlessly', 'cutting-edge', 'state-of-the-art', 'game-changer', 'game changer',
  'paradigm shift', 'holistic', 'mission-critical', 'results-driven', 'move the needle',
  'low-hanging fruit', 'circle back', 'touch base', 'level up', 'delve into', 'dive deep',
  'unlock the potential', 'navigate the landscape', 'at the end of the day',
  'it is worth noting', "it's worth noting", "in today's fast-paced",
]

const TEMPLATE_OPENER = [
  /^(?:随着|在当今|近年来|伴随着|如今|当前[，,]?\s*随着)/u,
  /^(?:in today'?s|in recent years|as we all know|it is widely (?:known|acknowledged))/iu,
]
export const TEMPLATE_TURN = /(值得注意的是|需要指出的是|值得一提的是|不得不说|不难看出|众所周知|显而易见|毫无疑问|it should be noted|it is worth noting|notably|importantly|interestingly|needless to say)/iu
export const TEMPLATE_SUMMARY = /(综上所述|总而言之|总的来说|总之|综上|in conclusion|to sum up|all in all|overall,)/iu

const INTENSIFIER_CJK = /(显著|大幅|极大|快速|明显|巨幅|空前|颠覆(?:性)?|革命性|行业领先|业内领先|最先进|唯一|首个|领先|全面提升|有效改善|极大提升)/gu
const INTENSIFIER_EN = /\b(significantly|dramatically|substantially|considerably|remarkably|extremely|hugely|incredibly|world-leading|industry-leading|first-ever|revolutionary|massive)\b/giu
const COMPARATIVE = /(更好|更快|更便宜|更高|更强|更优|更省|\b(better|faster|cheaper|higher|stronger|superior)\b)/iu
const BASELINE = /(相比|对比|比照|相对于|较之|基线|基准|相比之?下|than\b|compared (?:to|with)|versus|\bvs\.?\b)/iu

/** A1 已收录的词（小写）。A4 命中这些词时跳过 —— 同一处不被两条近义规则重复扣分（同一处只罚一次）。 */
const A1_WORDS = new Set([...VACUOUS_CJK, ...VACUOUS_EN.map(word => word.toLowerCase())])

export const CLAIM = /(必须|应该|应当|建议|证明|表明|说明|意味着|因此|所以|显然|可见|由此可见|可以断定|must\b|should\b|proves?\b|shows?\b|means\b|therefore\b|clearly\b|we recommend)/iu
export const EVIDENCE = /(因为|依据|根据|来源|数据|实测|案例|引自|据[^，。]{0,6}(?:统计|报告|测试)|图\s*\d|表\s*\d|编号|原文|链接|https?:\/\/|参照|出处|\bref\b|\bsource\b|according to|\bper\b|measured|tested|\bdata\b|benchmark)/iu

const DECISION_MARK = /(风险|代价|成本|限制|权衡|缺点|不足|未决|待定|依赖|假设|边界条件|取舍|副作用|劣势|风险点|trade-?off|risk|limitation|assumption|open question|downside|constraint|con)/iu
const OPTION_MARK = /(方案\s*[A-Za-z一二三1-3]|选项\s*[A-Za-z一二三1-3]|备选|alternative|option\s*[A-C1-3]|three options|三案)/iu
const COMPARE_MARK = /(对比|相比|优劣|取舍|权衡|各有|差别|区别|versus|vs\.?|trade-?off|compare)/iu

// ── 责任人 / 期限 / 动作 三张词表 ──────────────────────────────────────
//
// ★ 0.3.11 实测：一份《经销商协议》里的
//     「经销商需在收货后 60 天内提交 3 组实测素材」
//     「Distributor shall deliver valid automotive field test cases within 60 days」
//   被判成「责任人与期限均未说明」—— 两样都明明写在句子里。
//
//   词表漏一个写法，读者看到的不是"我不知道"，而是**一个确定的错误判断**。
//   这比不判严重得多：不判时读者会自己去看，判错时读者会去改一个没有病的地方。
//
//   补的是两类写法（不是补几个词，是补两类句式）：
//     · 期限：within 60 days / 60 days after receipt / 90-day / 收货后 60 天内 / 15 个工作日内
//     · 责任人：X shall … / borne by X / 由 X 承担
//
//   英文动词一律加词边界：原先 `ship` 会命中 "Shipping cost"，
//   把一条**费用归属条款**当成"要人去发货"，再判它缺期限。
export const OWNER_MARK = /(负责|牵头|责任人|由[^，。]{0,10}(?:负责|牵头|承办|跟进|承担)|待办\s*[:：]|跟进人|\bowner\b|\baction item\b|\bDRI\b|\bresponsible\b|assigned to|\bborne\s+by\b|\bshall\b)/iu
export const TIME_MARK = /(截止|期限|\bDDL\b|\bdeadline\b|(?:(?:19|20)\d{2}\s*[-/年]\s*\d{1,2})|(?:\d{1,2}\s*月\s*\d{1,2}\s*日)|(?:\d{1,2}\s*月\s*底)|(?:本|下|上)(?:周|月)|\bQ[1-4]\b|\bby\s+\d|第\s*\d+\s*(?:周|天)|\d+\s*(?:个)?(?:工作日|日历日|天|日|周|个月)\s*(?:内|以内|之内)|\bwithin\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fourteen|thirty|sixty|ninety)\s+(?:calendar\s+|business\s+|working\s+)?(?:days?|weeks?|months?)|\b\d+\s*[-–]\s*day\b|\b\d+\s+days?\s+(?:after|of|from|before)\b)/iu
export const ACTION_MARK = /(提交|完成|上线|修复|确认|提供|发送|评审|拉通|落地|执行|推进|跟进|安排|排期|实施|验收|\bdeploy\b|\bship\b|\bdeliver\b|\bsubmit\b|\breview\b|\bfix\b|\bconfirm\b)/iu

/**
 * 这条动作是**要谁做** —— 归属分层。
 *
 * ★ 老板 0.3.11 反馈（提炼 · ⑥ 执行）：「责任人与期限均未说明这种没有区分
 *   哪些是汇报人要做的，哪些是汇报人阐述的内容」。
 *
 *   这就是问题的根：一份协议里绝大多数句子是**对方义务**
 *   （「经销商须…」「Distributor shall…」「Shipping cost borne by Distributor」），
 *   责任人由条款主语给出，本来就写明了。
 *   拿"作者有没有写责任人"去罚它们，罚的是一个不存在的问题。
 *
 *   所以先分层，再判缺项：
 *     other  对方 / 第三方义务  → 责任人 = 该方；缺期限只作**事实**记录，不计缺口
 *     self   对读者 / 我方的要求 → 缺责任人、缺期限都算缺陷
 *     none   无主语              → 按"未说明"处理（这是真歧义，该追问）
 *
 *   ⚠️ 判据全是词面，不做语义推理；判错时读者能一眼看出主语，从而不采信这一条。
 */
export const PARTY_OTHER = /(经销商|代理商|分销商|供应商|厂商|工厂|客户|买方|卖方|甲方|乙方|承运商|物流商|服务商|承包方|委托方|对方|平台方|distributors?|suppliers?|vendors?|customers?|partners?|clients?|buyers?|sellers?|contractors?|factories)/iu
export const PARTY_SELF = /(我方|我们|我司|本公司|本部门|本人|贵司|\bwe\b|\bour\b|\bus\b)/iu
/** 对读者的祈使式要求 —— 没有主语也指向读者。 */
export const READER_IMPERATIVE = /^\s*(?:请|务必|烦请|需你|请你|你(?:需要|需|要)|\bplease\b)/iu
/**
 * 否定式义务 —— 「仅负责上架销售、**无**案例提交义务」不是一条待办。
 * 原先它靠 ACTION_MARK 里的「提交」混进执行池，再被判"缺期限"：
 * 工具在要求作者给一件"不要求做"的事定期限。
 */
export const NEGATED_DUTY = /((?:无|不|非|免)[^，。；;\n]{0,6}(?:义务|责任|要求))|(?:不需要|无需|免于)|\bnot\s+(?:required|obliged|obligated)|\bno\s+obligation\b/iu

/** 主体名册判定 → { party: 'other'|'self'|'none', name }。 */
export function partyOf(text) {
  const body = String(text ?? '')
  // 主语几乎总在句首，先只看前 32 字，避免句子中间的"客户"把归属带偏
  const head = body.slice(0, 32)
  const other = PARTY_OTHER.exec(head)
  const selfMark = PARTY_SELF.exec(head)
  if (other !== null && (selfMark === null || other.index <= selfMark.index)) {
    return { party: 'other', name: other[0] }
  }
  // 「borne by Distributor」「由经销商承担」把主体写在句尾，扩到全句再找一次。
  // 但**必须**再确认一次名册：句首查不到就去句尾硬认，会把「由张三负责」这种
  // 内部派活也判成对方义务 —— 那正好是这条规则最不该犯的错。
  const tail = /\bborne\s+by\s+([A-Za-z][A-Za-z&\-]{1,20})/u.exec(body)
    ?? /由\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12}?)\s*(?:负责|牵头|承办|承担|提供|完成)/u.exec(body)
  if (tail !== null && PARTY_OTHER.test(tail[1])) {
    return { party: 'other', name: tail[1].trim() }
  }
  if (selfMark !== null) return { party: 'self', name: selfMark[0] }
  if (READER_IMPERATIVE.test(body)) return { party: 'self', name: '读者' }
  return { party: 'none', name: '' }
}

export const PURPOSE_MARK = /(目的[:：是为]?|旨在|为了|本次|本报告|本文|本方案|本件|待决|需决定|请审批|请确认|请评估|议题|结论先行|目标[:：是为]|purpose|objective|goal|aim|this (?:report|document|proposal|memo)|we propose|we recommend|decision needed)/iu
export const PURPOSE_SPECIFIC = /(决定|选择|审批|确认|拍板|取舍|请求|请\s*[^。\n]{0,8}|decide|choose|approve|confirm|sign off)/iu

/* ─────────────────────────── 共用工具 ──────────────────────────────── */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/** 按命中数取严重度档位（tiers 为 [阈值, 严重度] 升序）。 */
function tier(count, tiers) {
  let severity = 0
  for (const [threshold, value] of tiers) if (count >= threshold) severity = value
  return severity
}

function hitOf(ctx, { rule, dimension, severity, start, end, why, fix, note }) {
  const snippet = ctx.text.slice(Math.max(0, start), Math.min(ctx.text.length, end))
  const at = locate(ctx.text, start)
  return {
    rule,
    dimension,
    severity,
    snippet: snippet.length > 160 ? `${snippet.slice(0, 157)}…` : snippet,
    start,
    end,
    line: at.line,
    why,
    fix,
    ...(note === undefined ? {} : { note }),
  }
}

/** 段落 → 句子（带全局偏移）。 */
function sentenceIndex(ctx) {
  const out = []
  for (const paragraph of ctx.paragraphs) {
    for (const sentence of splitSentences(paragraph.text)) {
      out.push({
        text: sentence.text,
        start: paragraph.start + sentence.start,
        end: paragraph.start + sentence.end,
        paragraphStart: paragraph.start,
        paragraphEnd: paragraph.end,
      })
    }
  }
  return out
}

/** 建评估上下文（一次算好，供 11 个维度共用）。 */
export function buildContext(text, { includeSnippets = true } = {}) {
  const source = String(text ?? '')
  const paragraphs = splitParagraphs(source)
  const ctx = {
    text: source,
    paragraphs,
    stats: computeStats(source),
    quotes: quoteRanges(source),
    includeSnippets,
  }
  ctx.sentences = sentenceIndex(ctx)
  ctx.repetition = findRepetition(source)
  return ctx
}

const inQuote = (ctx, start) => insideRanges(start, ctx.quotes)

/* ──────────────────────── A 组：表达水分 ───────────────────────────── */

function evaluateA1(ctx) {
  const hits = []
  const seen = new Set()

  const scan = (word, regex) => {
    for (const match of ctx.text.matchAll(regex ?? new RegExp(word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'))) {
      const start = match.index
      if (inQuote(ctx, start)) continue
      if (seen.has(word)) continue
      seen.add(word)
      hits.push(hitOf(ctx, {
        rule: 'A1-套话',
        dimension: 'A1',
        severity: 1,
        start,
        end: start + match[0].length,
        why: `「${match[0]}」删掉后，这句话的事实、判断与必要语境都不变 —— 它承担的是语气，不是信息。`,
        fix: '换成具体动作与对象（对谁、做了什么、结果可核到什么程度），或者直接删。',
      }))
    }
  }

  for (const word of VACUOUS_CJK) scan(word)
  for (const word of VACUOUS_EN) scan(word, new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'giu'))

  const count = hits.length
  let severity = tier(count, [[1, 1], [3, 2], [6, 3], [10, 4]])
  const density = ctx.sentences.length === 0 ? 0 : count / ctx.sentences.length
  // 密度加成只在句子够多时才成立：4 句话里 10 个套话词是"每句都有"，不是"密度高"。
  if (density > 0.3 && ctx.sentences.length >= 8 && severity > 0) severity = clamp(severity + 1, 0, 4)
  // 有实质内容就不判"基本无法完成"：一篇含真实数据的方案，套话再多也只是拖慢阅读，
  // 说它"使交付目标无法完成"是过度断言，会直接毁掉分数的可信度。
  if (severity >= 4 && (ctx.stats.factSentenceRatio ?? 0) >= 0.3) severity = 3

  const note = ctx.quotes.length > 0
    ? `引号内引用不计入（共 ${ctx.quotes.length} 处引号区间已排除）。`
    : undefined

  return {
    severity,
    hits: hits.slice(0, 30),
    note: [note, count > hits.slice(0, 30).length ? `另有 ${count - 30} 处未列出。` : undefined]
      .filter(Boolean).join(' ') || undefined,
    summary: count === 0
      ? `检查了 ${VACUOUS_CJK.length + VACUOUS_EN.length} 个套话词表条目，未命中。`
      : `命中 ${count} 个不同的套话词（同词只计一次）；命中密度 ${(density * 100).toFixed(0)}%（命中数 ÷ 句数）。`,
  }
}

/**
 * 从一条 8 字命中向右扩张到"两次出现仍然逐字相同"的最长连续原文。
 * 目的：把滑窗碎片还原成"被重复的那一整句"，让一条证据对得上读者的观感。
 * 做法：把首次出现位置（mirror）与第二次出现位置（start）逐位对齐比较，取最长公共前缀 ——
 * 单步 O(1)，总代价 ≤ 上限字数，不随正文长度膨胀（早先写的 split 计数版在 60 万字体量上会到 10 亿次比较）。
 * 上限 +120 字：高度重复的文档里不做无界膨胀（宁可少说，不可把整篇糊成一条）。
 */
function growVerbatimSpan(text, start, mirror, unit) {
  let length = unit.length
  const limit = Math.min(unit.length + 120, text.length - start, text.length - mirror)
  while (length < limit && text[mirror + length] === text[start + length]) length += 1
  return start + length
}

function evaluateA2(ctx) {
  const hits = []
  const { removedChars, units } = ctx.repetition
  const charsNoSpace = Math.max(1, ctx.stats.charsNoSpace)
  const removedRatio = removedChars / charsNoSpace

  // 同一处重复会以"滑窗偏移 1 字"产出多条 unit：45 字的重复句能连出近 40 条重叠窗口，
  // 每条还各配一份相同的原因与改法。实测下来用户看到的不是"有一句重复了"，
  // 而是"报了四条、条条相同" —— 这会直接削弱对整份报告的信任。
  // 修法：先长回整句，再按区间重叠去重（保留最先接受、因而最长的那条）。
  const spans = []
  for (const unit of units.slice(0, 12)) {
    const first = ctx.text.indexOf(unit)
    const second = first < 0 ? -1 : ctx.text.indexOf(unit, first + 1)
    if (second < 0) continue
    const end = growVerbatimSpan(ctx.text, second, first, unit)
    if (spans.some(span => second < span.end && end > span.start)) continue
    spans.push({ start: second, end })
  }

  for (const span of spans) {
    const snippet = ctx.text.slice(span.start, span.end)
    hits.push(hitOf(ctx, {
      rule: 'A2-重复片段',
      dimension: 'A2',
      severity: 2,
      start: span.start,
      end: span.end,
      why: `「${snippet}」在文中至少出现两次 —— 第二次之后不提供新信息，只增加阅读成本。`,
      fix: '保留一次，其余删除；若确有不同侧重，请改写为新增的判断而不是复述。',
    }))
  }

  // 相邻句高度相似（换词复述同一句）
  let adjacentPairs = 0
  for (let at = 1; at < ctx.sentences.length; at += 1) {
    const previous = ctx.sentences[at - 1]
    const current = ctx.sentences[at]
    if (current.text.length < 12 || previous.text.length < 12) continue
    const similarity = jaccard(bigramSet(previous.text), bigramSet(current.text))
    if (similarity < 0.7) continue
    adjacentPairs += 1
    hits.push(hitOf(ctx, {
      rule: 'A2-相邻复述',
      dimension: 'A2',
      severity: 2,
      start: current.start,
      end: current.end,
      why: `与前一句字符二元组重合度 ${(similarity * 100).toFixed(0)}% —— 两句在说同一件事。`,
      fix: '合并为一句，或补上后一句真正新增的信息（数字、条件、结论差异）。',
    }))
  }

  let severity = tier(removedRatio, [[0.02, 1], [0.06, 2], [0.15, 3], [0.25, 4]])
  if (adjacentPairs >= 3) severity = clamp(severity + 1, 0, 4)

  return {
    severity,
    hits: hits.slice(0, 24),
    // 「分数必须可回溯」是这套东西的立身之本：重复是在"去标点后的内容序列"上算出来的，
    // 若重复跨了标点/换行，就无法映射回一段连续原文 —— 此时不能静默扣分了事，必须把证据缺口说出来。
    note: hits.length === 0 && removedChars > 0
      ? `已在去标点后的内容序列上检出约 ${removedChars} 字重复，但无法映射回一段连续原文`
        + '（重复片段跨越了标点或换行）—— 本维按"扣分须有证据定位"的原则只保留最低档严重度，不据此升级。'
      : undefined,
    summary: `重复片段覆盖约 ${(removedRatio * 100).toFixed(1)}% 的正文（${removedChars} 字），相邻句复述 ${adjacentPairs} 处。`,
  }
}

function evaluateA3(ctx) {
  const hits = []
  const categories = new Set()

  // 套路开场只在前 3 段里找：真实文件的第一段常常是标题，开场白在第二段 ——
  // 只看 paragraphs[0] 会漏掉「随着行业的快速发展…」这种最典型的套路（实测漏过一次）。
  for (const paragraph of ctx.paragraphs.slice(0, 3)) {
    const found = TEMPLATE_OPENER
      .map(pattern => pattern.exec(paragraph.text.trim()))
      .find(match => match !== null)
    if (found === undefined || found === null) continue
    categories.add('opener')
    hits.push(hitOf(ctx, {
      rule: 'A3-套路开场',
      dimension: 'A3',
      severity: 1,
      start: paragraph.start,
      end: paragraph.start + found[0].length,
      why: '「随…而…」式开场不提供对象、时间与量级，读者要读到第三段才知道在说什么。',
      fix: '第一句直接写结论或待决问题，把背景放到第二段。',
    }))
    break
  }

  for (const match of ctx.text.matchAll(new RegExp(TEMPLATE_TURN.source, 'giu'))) {
    if (inQuote(ctx, match.index)) continue
    categories.add('turn')
    hits.push(hitOf(ctx, {
      rule: 'A3-假转折',
      dimension: 'A3',
      severity: 1,
      start: match.index,
      end: match.index + match[0].length,
      why: `「${match[0]}」标记了"重点来了"，但后面的内容未必是重点 —— 这个转折词没有任何信息量。`,
      fix: '删掉它，直接写要说的事；如果后面确实不是重点，那更该删。',
    }))
  }

  for (const match of ctx.text.matchAll(new RegExp(TEMPLATE_SUMMARY.source, 'giu'))) {
    if (inQuote(ctx, match.index)) continue
    categories.add('summary')
    hits.push(hitOf(ctx, {
      rule: 'A3-机械总结',
      dimension: 'A3',
      severity: 1,
      start: match.index,
      end: match.index + match[0].length,
      why: `「${match[0]}」之后若只是重复前文，这段总结等于把读者已读的内容再读一遍。`,
      fix: '总结里只放前文没有明说的判断（例如取舍结论、下一步），否则删。',
    }))
  }

  // 排比空转：连续 ≥3 句同句首、且都不含数字
  let runLength = 1
  for (let at = 1; at < ctx.sentences.length; at += 1) {
    const head = text => text.replace(/^[\s\-*+•>#\d.)、]+/u, '').slice(0, 3)
    const same = head(ctx.sentences[at].text) === head(ctx.sentences[at - 1].text)
    const hasNumber = /\d/u.test(ctx.sentences[at].text)
    runLength = same && !hasNumber ? runLength + 1 : 1
    if (runLength === 3) {
      categories.add('parallel')
      hits.push(hitOf(ctx, {
        rule: 'A3-排比空转',
        dimension: 'A3',
        severity: 2,
        start: ctx.sentences[at - 2].start,
        end: ctx.sentences[at].end,
        why: '连续 3 句同句首且都不含数字 —— 这是排比的气势，不是并列的信息。',
        fix: '改成带数量的清单，或合成一句并补上各自的差异。',
      }))
    }
  }

  let severity = 0
  if (hits.length > 0) {
    severity = categories.size >= 3 ? 3 : (hits.length >= 3 ? 2 : 1)
    if (categories.has('parallel')) severity = clamp(severity + 1, 0, 4)
  }

  return {
    severity,
    hits: hits.slice(0, 20),
    summary: hits.length === 0
      ? '未命中套路开场 / 假转折 / 机械总结 / 排比空转。'
      : `命中 ${hits.length} 处，覆盖 ${categories.size} 类模板（开场/转折/总结/排比）。`,
  }
}

function evaluateA4(ctx) {
  const hits = []
  const protectedHits = []

  const contextWindow = index => {
    const parts = []
    if (index > 0) parts.push(ctx.sentences[index - 1].text)
    parts.push(ctx.sentences[index].text)
    if (index + 1 < ctx.sentences.length) parts.push(ctx.sentences[index + 1].text)
    return parts.join(' ')
  }

  for (let at = 0; at < ctx.sentences.length; at += 1) {
    const sentence = ctx.sentences[at]
    const window = contextWindow(at)
    const hasFigure = /\d/u.test(window) || /(%|％|元|万元|亿元|小时|分钟|次|倍|件|台|个|吨|USD|CNY|EUR|GBP|ms|GB|MB)/iu.test(window)

    for (const pattern of [INTENSIFIER_CJK, INTENSIFIER_EN]) {
      for (const match of sentence.text.matchAll(pattern)) {
        const start = sentence.start + match.index
        if (inQuote(ctx, start)) continue
        // 去重（同一处只罚一次）：这个词若已在 A1 词表里，由 A1 计一次，A4 不再重复扣分
        if (A1_WORDS.has(match[0].toLowerCase())) continue
        if (hasFigure) {
          protectedHits.push(match[0])
          continue
        }
        hits.push(hitOf(ctx, {
          rule: 'A4-无基准程度词',
          dimension: 'A4',
          severity: 1,
          start,
          end: start + match[0].length,
          why: `「${match[0]}」既没有基准也没有量级 —— 读者无法判断幅度多大、相对什么、差多少。`,
          fix: '补上数字与基准（相对什么、多少、什么时候），补不上就删掉这个程度词。',
        }))
      }
    }

    if (COMPARATIVE.test(sentence.text) && !BASELINE.test(sentence.text) && !hasFigure) {
      const match = COMPARATIVE.exec(sentence.text)
      const start = sentence.start + match.index
      if (!inQuote(ctx, start)) {
        hits.push(hitOf(ctx, {
          rule: 'A4-无对象比较',
          dimension: 'A4',
          severity: 2,
          start,
          end: start + match[0].length,
          why: '出现了比较级，但没写跟谁比、比哪一项、差多少 —— 比较没有对象就不是结论。',
          fix: '写明对比对象与差值（如"比上一版少 2 天"），或改成不带比较的陈述。',
        }))
      }
    }
  }

  const count = hits.length
  let severity = tier(count, [[1, 1], [3, 2], [6, 3]])
  if (ctx.sentences.length > 0 && count / ctx.sentences.length > 0.2) severity = clamp(severity + 1, 0, 4)

  const notes = []
  if (protectedHits.length > 0) {
    notes.push(`有 ${protectedHits.length} 处程度词附近带数字/单位，已按保护项放过（不扣分）。`)
  }
  if (count === 0 && protectedHits.length === 0) notes.push('未发现无基准的程度词或无对象比较。')

  return { severity, hits: hits.slice(0, 24), note: notes.join(' '), summary: notes.join(' ') }
}

/* ──────────── A5 的判定对象：段落与段落之间有没有推进关系 ───────────────
 *
 * ★ 2026-10-19 裁决：标题层级跳跃 / 空标题 / 单条列表 / 强调过载**一律不计分**。
 *   这四条判的都是**排版格式**，不是"段落之间的语义结构" —— 而 A5 只对后者负责。
 *
 *   实测症状（老板贴的截图）：一份正常报告因为 H3→H5 跳级，被报了 4 条**一模一样的**
 *   「为什么 / 怎么改」，报告上写着「发现 5 处结构问题」。那条规则判的是 `#` 的个数，
 *   与"这一段有没有推进上一段"毫无关系；读者却会以为这份文档内容结构有毛病。
 *
 *   顺带修掉第二个缺陷：同一规则的重复命中没有合并。`severity = tier(hits.length, …)`
 *   意味着"一条规则发现 4 处同类格式问题"就把维度严重度顶到 2 级。A2 早在 0.2.x
 *   踩过同一个坑（见 evaluateA2 上方注释：报了四条、条条相同 → 直接削弱对报告的信任），
 *   A5 没做同样处理。本次统一：**severity 按全量对数算，证据最多列 3 条**。
 *
 *   格式层面仍在 summary/note 里如实披露"查了什么、查到几条" ——
 *   「不计入评分」不等于「不告诉你」。
 */

/** 段首推进标记 —— 出现即认为与上一段有承接。宁宽勿严：漏报好过误报。 */
const PROGRESSION_MARKERS = [
  // 因果 / 推论
  '因此', '所以', '因而', '于是', '从而', '据此', '由此可见', '这意味着', '这就意味着',
  '结果是', '导致', '基于此', '由此',
  // 转折 / 对比
  '但是', '然而', '不过', '相反', '反之', '另一方面', '相比之下', '与此相对',
  // 递进 / 并列推进
  '另外', '此外', '同时', '其次', '再次', '再者', '进一步', '更重要的是',
  '首先', '第一', '第二', '第三', '最后', '综上', '总而言之', '总的来说', '小结',
  // 条件 / 限定
  '如果', '若', '除非', '前提是', '在这种情况下', '在这个前提下',
  // 回指 —— 段首回指几乎必然是承接
  '上述', '前者', '后者', '该', '此', '其', '这', '它',
  // 时间 / 顺序
  '之后', '随后', '此前', '目前', '下一步', '接下来',
]

const PROGRESSION_EN = [
  'therefore', 'thus', 'hence', 'consequently', 'however', 'but', 'moreover',
  'furthermore', 'additionally', 'in addition', 'meanwhile', 'as a result',
  'in contrast', 'conversely', 'similarly', 'first', 'second', 'third', 'finally',
  'overall', 'in short', 'this', 'these', 'those', 'such', 'it', 'they', 'that',
]

const CJK_RUNS = /[\u4e00-\u9fff]+/gu
const LATIN_WORDS = /[A-Za-z]{4,}/gu
const HEADING_LINE = /^#{1,6}\s+\S/u
const LIST_LINE = /^(?:[-*+•]|\d{1,2}[.)])\s+\S/u
const EDGE_MARKS = /^[\s>#*+\-\d.)|]+/u

/** 去掉段首的 markdown 修饰符，取前 16 字判承接。 */
const headOf = text => text.replace(EDGE_MARKS, '').slice(0, 16)

function startsWithProgression(text) {
  const head = headOf(text)
  if (head === '') return true
  for (const marker of PROGRESSION_MARKERS) if (head.startsWith(marker)) return true
  const flat = text.replace(EDGE_MARKS, '').toLowerCase()
  for (const marker of PROGRESSION_EN) {
    if (flat.startsWith(`${marker} `) || flat.startsWith(`${marker},`) || flat === marker) return true
  }
  return false
}

/** 中文取 4 字窗口、英文取 ≥4 字母词 —— 只用于判"两段有没有共同的实词片段"。 */
function contentWindows(text) {
  const windows = new Set()
  for (const run of text.match(CJK_RUNS) ?? []) {
    for (let at = 0; at + 4 <= run.length; at += 1) windows.add(run.slice(at, at + 4))
  }
  for (const word of text.match(LATIN_WORDS) ?? []) windows.add(word.toLowerCase())
  return windows
}

function sharesContent(previous, current) {
  const before = contentWindows(previous)
  if (before.size === 0) return false
  for (const window of contentWindows(current)) if (before.has(window)) return true
  return false
}

/** 段落块 → 去掉段首标题行之后的正文；偏移仍然对得回原文。 */
function contentBlock(paragraph) {
  const lines = paragraph.text.split('\n')
  let at = 0
  let skip = 0
  while (at < lines.length && HEADING_LINE.test(lines[at].trim())) {
    skip += lines[at].length + 1
    at += 1
  }
  return {
    text: lines.slice(at).join('\n'),
    start: Math.min(paragraph.start + skip, paragraph.end),
  }
}

/**
 * 纯列表块、纯表格块不参与"段间推进"判定。
 *
 * ★ 这里保留两段血泪备注（原 A5-空标题 / A5-单条列表 的实测回归）：
 *   ① 父标题紧跟子标题**不是**空标题 —— 中文报告默认就是「## 一、/ ### 1.1」两级排版，
 *      当年"下一个非空行只要是标题就判空"把每一个父标题都误报了一遍。
 *   ② 项与项之间空一行的"松散列表"是合法写法 —— 当年按空行切块，于是每一个列表项
 *      都被误报成"单条列表"。
 *   这两条规则现在不计分了，但结论不能丢：**格式类判断极易误报，本就不该进分数。**
 */
function isListOrTable(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return true
  return lines.every(line => LIST_LINE.test(line) || line.startsWith('|'))
}

const tailOf = text => text.replace(/\s+/gu, ' ').trim().slice(-24)
const headText = text => text.replace(/\s+/gu, ' ').trim().slice(0, 70)

function evaluateA5(ctx) {
  const boldRatio = ctx.stats.charsNoSpace === 0
    ? 0
    : Math.round((ctx.stats.boldChars / ctx.stats.charsNoSpace) * 100)
  const formatDisclosure = `格式层面另检：标题 ${ctx.stats.headings} 个、列表项 ${ctx.stats.listItems} 个、`
    + `加粗占比 ${boldRatio}% —— 标题层级跳跃 / 空标题 / 单条列表 / 强调过载属排版格式，`
    + '不是段落之间的语义结构，一律不计分。'

  const blocks = ctx.paragraphs
    .map(contentBlock)
    .filter(block => block.text.replace(/\s/gu, '').length >= 30)
    .filter(block => !isListOrTable(block.text))

  if (blocks.length < 3) {
    return {
      state: 'not-applicable',
      reason: `可参与判定的正文段落只有 ${blocks.length} 段（需 ≥3 段）—— `
        + '段与段的关系无从谈起，本维不适用，不当缺陷计。',
      severity: 0,
      hits: [],
      note: formatDisclosure,
      summary: '正文段落不足 3 段，段间关系不适用。',
    }
  }

  let pairs = 0
  const stalled = []
  for (let at = 1; at < blocks.length; at += 1) {
    const previous = blocks[at - 1]
    const current = blocks[at]
    pairs += 1
    if (startsWithProgression(current.text)) continue
    if (sharesContent(previous.text, current.text)) continue
    stalled.push({ previous, current })
  }

  const ratio = pairs === 0 ? 0 : stalled.length / pairs
  const judged = pairs >= 3 && stalled.length >= 3 && ratio >= 0.5
  const severity = judged ? tier(stalled.length, [[3, 1], [6, 2], [10, 3]]) : 0
  const percent = Math.round(ratio * 100)

  // 证据最多列 3 条：severity 按全量对数算，不按列出的条数算。
  const hits = (judged ? stalled.slice(0, 3) : []).map(pair => hitOf(ctx, {
    rule: 'A5-段间无推进',
    dimension: 'A5',
    severity: 1,
    start: pair.current.start,
    end: pair.current.start + Math.min(70, pair.current.text.length),
    why: `上一段以「${tailOf(pair.previous.text)}」收尾，这一段以「${headText(pair.current.text)}」开头`
      + ' —— 两段之间既没有承接词，也没有共同的实词片段。把两段对调，读起来一样通顺：'
      + '它们是并排摆放的，不是推进关系。',
    fix: '补一句过渡（承接 / 因果 / 转折），或把这一段并进上一段；'
      + '如果本来就是并列要点，用列表表达并列，别用分段暗示推进。',
  }))

  const note = [
    formatDisclosure,
    judged && stalled.length > 3 ? `另有 ${stalled.length - 3} 对无推进的相邻段未逐条列出。` : undefined,
  ].filter(Boolean).join(' ')

  const summary = judged
    ? `相邻段落 ${pairs} 对，其中 ${stalled.length} 对既无承接词也无共同实词（占 ${percent}%）`
      + ' —— 段落可任意换序，是并排堆放而非推进。'
    : (stalled.length === 0
      ? `相邻段落 ${pairs} 对，每对都有承接词或共同实词 —— 段落之间存在推进关系。`
      : `相邻段落 ${pairs} 对，其中 ${stalled.length} 对无承接词也无共同实词（占 ${percent}%），`
        + '未达判"并排堆放"的门槛（需 ≥3 对且占比 ≥50%），仅作提示、不计分。')

  return { severity, hits, note, summary }
}

/* ──────────────────────── B 组：工作空转 ───────────────────────────── */

function evaluateB1(ctx, docType) {
  // ⚠️ 窗口必须与 distill.mjs 的 distillPurpose 完全一致（前 25% 的句子，至少 3 句）。
  //    实测出现过自相矛盾：B1 用"前 max(400字, 25%字)"扫到了第 4 句，说"提到了目的但不具体"；
  //    提炼用"前 3 句"没扫到，说"未明示"。同一份文件、同一个概念给出两个结论，
  //    读者只会认为这套工具在乱说。窗口口径写死在一处、两边引用同一规则。
  const windowCount = Math.max(3, Math.ceil(ctx.sentences.length * 0.25))
  const headSentences = ctx.sentences.slice(0, windowCount)
  const headEnd = headSentences.length === 0 ? 0 : headSentences[headSentences.length - 1].end
  const head = ctx.text.slice(0, headEnd)
  const purposeSentence = headSentences.find(sentence => PURPOSE_MARK.test(sentence.text))

  const hits = []
  let severity = 0

  if (purposeSentence === undefined) {
    severity = 2
    hits.push(hitOf(ctx, {
      rule: 'B1-缺目的陈述',
      dimension: 'B1',
      severity,
      start: 0,
      end: Math.min(60, ctx.text.length),
      why: `前 ${windowCount} 句（约 ${headEnd} 字）内没有出现"目的/旨在/待决/请确认"这类陈述 —— `
        + '读者要读到很后面才知道这份文件要干什么。',
      fix: '开头加一句：这份文件要解决什么、希望读者做什么决定或行动。',
      note: `已检查范围：前 ${windowCount} 句 / 全文共 ${ctx.sentences.length} 句。`,
    }))
  } else if (!PURPOSE_SPECIFIC.test(purposeSentence.text)) {
    severity = 1
    hits.push(hitOf(ctx, {
      rule: 'B1-目的不具体',
      dimension: 'B1',
      severity,
      start: purposeSentence.start,
      end: purposeSentence.end,
      why: '提到了目的，但没说要读者做什么（决定 / 审批 / 确认）；目的句停在"介绍"层面。',
      fix: '补上期待的动作与对象：要谁、在什么时点前、做什么决定。',
    }))
  } else {
    hits.push(hitOf(ctx, {
      rule: 'B1-目的已明示',
      dimension: 'B1',
      severity: 0,
      start: purposeSentence.start,
      end: purposeSentence.end,
      why: '开篇即给出目的与期待动作 —— 这是加分项，此处仅作定位，不扣分。',
      fix: '—',
    }))
  }

  if (docType === 'minutes' && !/(议题|议程|agenda|topic)/iu.test(head)) {
    severity = clamp(severity + 1, 0, 4)
    hits.push(hitOf(ctx, {
      rule: 'B1-纪要缺议题',
      dimension: 'B1',
      severity: 1,
      start: 0,
      end: Math.min(60, ctx.text.length),
      why: '会议纪要没写议题/议程，读者无法判断哪些讨论被漏记了。',
      fix: '开头列出本次会议议题清单。',
    }))
  }

  // ★ B 已退出计分体系，摘要里**不得再出现"严重度"字样** ——
  //   状态列写着「线索 · 不计分」，说明列又说"严重度 2"，读者只会记住后者。
  //   摘要要说的是"看到了什么"，不是"扣了几分"。
  const summary = severity === 0
    ? '目的陈述明确且指向具体动作。'
    : (hits.some(hit => hit.rule === 'B1-缺目的陈述')
      ? '开头没有给出目的陈述 —— 读者要读到后面才知道这份文件要干什么。'
      : '提到了目的，但没说要读者做什么（决定 / 审批 / 确认）。')
  return { severity, hits, summary }
}

function evaluateB2(ctx) {
  const { factSentenceRatio, charsNoSpace, numbers, dates } = ctx.stats

  if (charsNoSpace < 150) {
    return {
      state: 'insufficient',
      reason: `正文仅 ${charsNoSpace} 字，实质信息密度不具判别力（短文本波动过大）。`,
      severity: 0,
      hits: [],
      summary: '文本过短，本维未能评估。',
    }
  }

  const hits = []
  let severity = tier(factSentenceRatio, [[0.10, 4], [0.20, 3], [0.30, 2], [0.40, 1]])
  if (charsNoSpace > 1200 && numbers === 0 && dates === 0) {
    severity = clamp(severity + 1, 0, 4)
    hits.push(hitOf(ctx, {
      rule: 'B2-长文无数字',
      dimension: 'B2',
      severity: 3,
      start: 0,
      end: Math.min(160, ctx.text.length),
      why: `正文 ${charsNoSpace} 字，全篇没有任何数字或日期 —— 这类长篇文件通常靠概念推进，缺少可核的锚点。`,
      fix: '补上关键量：数量、金额、时长、比例、时点。哪怕估算也要标"估算"。',
    }))
  }

  // 抽样的对象必须是**论证句**。标题和表格行不是：
  // 标题没有数字天经地义，表格行本身就是数据。把它们抽进来，
  // 每一份带层级标题的报告都会白吃几条"无事实锚点"。实测踩到过。
  const sample = ctx.sentences
    .filter(sentence => !EVIDENCE.test(sentence.text))
    .filter(sentence => !/^#{1,6}\s/u.test(sentence.text.trim()))
    .filter(sentence => !/^\|/u.test(sentence.text.trim()))
    .slice(0, 5)
  for (const sentence of sample) {
    if (severity === 0) break
    if (/\d/u.test(sentence.text)) continue
    hits.push(hitOf(ctx, {
      rule: 'B2-无事实锚点',
      dimension: 'B2',
      severity: 1,
      start: sentence.start,
      end: sentence.end,
      why: '这一句里没有数字、日期、单位或机制描述 —— 它读起来像判断，但落不到可核的东西上。',
      fix: '补一个可核的锚点，或把它降级为"待确认的假设"。',
    }))
  }

  return {
    severity,
    hits: hits.slice(0, 12),
    summary: `含事实锚点（数字/日期/单位/机制）的句子占 ${(factSentenceRatio * 100).toFixed(0)}%；全文 ${numbers} 个数值、${dates} 个日期。`,
  }
}

function evaluateB3(ctx) {
  const claims = ctx.sentences.filter(sentence => CLAIM.test(sentence.text))
  if (claims.length < 3) {
    return {
      state: 'insufficient',
      reason: `仅识别到 ${claims.length} 条主张句，样本不足以判定论证质量。`,
      severity: 0,
      hits: [],
      summary: `主张句 ${claims.length} 条，样本不足，本维未能评估。`,
    }
  }

  const hits = []
  let unsupported = 0
  for (const sentence of claims) {
    if (EVIDENCE.test(sentence.text)) continue
    unsupported += 1
    hits.push(hitOf(ctx, {
      rule: 'B3-主张无依据',
      dimension: 'B3',
      severity: 2,
      start: sentence.start,
      end: sentence.end,
      why: '这一句下了判断（必须/应该/表明/因此），但同句内没有任何依据标记（因为/根据/数据/来源/图表编号）。',
      fix: '补依据并定位（引哪份数据、哪次实测、哪张图），或把结论降级为"待验证"。',
    }))
  }

  const ratio = unsupported / claims.length
  let severity = tier(ratio, [[0.15, 1], [0.33, 2], [0.50, 3]])
  if (claims.length < 6 && severity > 2) severity = 2   // 样本小则封顶，避免以偏概全

  return {
    severity,
    hits: hits.slice(0, 16),
    summary: `主张句 ${claims.length} 条，其中 ${unsupported} 条（${(ratio * 100).toFixed(0)}%）同句内无依据标记。`,
  }
}

/**
 * 取数字前的"指标名"，**只认赋值形态**：`指标 + 分隔符 + 数字`。
 *
 * ★ 这里原本只要求"数字前有 2–8 个汉字"，结果是真实文件第一次跑就误报：
 *   「A渠道投入12万元…B渠道投入8万元」被判成"同一指标出现两个值"——
 *   可它们是**两个渠道各自的投入**，根本不是冲突。
 *   多一个赋值分隔符（：/为/是/达到/约/共计）就把这类并列描述排除了：
 *   「项目成本：12 万」是赋值，「A 渠道投入 12 万」不是。
 * @returns 指标名，或 null（= 这不是一次赋值，不参与一致性比对）
 */
function metricKey(text, index) {
  const before = text.slice(Math.max(0, index - 16), index)
  const match = /([\u3400-\u4dbf\u4e00-\u9fff]{2,8})\s*(?:[:：]|为|是|达到|约|约为|共计|合计)\s*$/u.exec(before)
  return match?.[1] ?? null
}

function evaluateB4(ctx) {
  const hits = []
  const source = ctx.text
  const numbers = [...source.matchAll(/(-?\d+(?:[.,]\d+)?)\s*(%|％|元|万元|亿元|美元|USD|CNY|EUR|GBP|小时|分钟|秒|天|周|个月|人次|次|倍|件|台|吨|kg|MB|GB|ms)?/giu)]
    .map(match => ({
      value: Number(String(match[1]).replace(/,/gu, '')),
      unit: (match[2] ?? '').toLowerCase(),
      start: match.index,
      text: match[0].trim(),
    }))
    .filter(item => Number.isFinite(item.value) && item.unit !== '')

  if (numbers.length < 3) {
    return {
      state: 'insufficient',
      reason: `带单位的数值仅 ${numbers.length} 个（<3），没有可比较的量。`,
      severity: 0,
      hits: [],
      summary: '可比较数值不足，本维未能评估。',
    }
  }

  // ① 同一指标名 + 同一单位 → 不同数值 = 冲突（要求：赋值形态 + 分处不同句子）
  const sentenceIndexAt = position => {
    for (let at = 0; at < ctx.sentences.length; at += 1) {
      const sentence = ctx.sentences[at]
      if (position >= sentence.start && position < sentence.end) return at
    }
    return -1
  }

  const groups = new Map()
  for (const item of numbers) {
    const key = metricKey(source, item.start)
    if (key === null) continue
    const groupKey = `${key}|${item.unit}`
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push({ ...item, sentence: sentenceIndexAt(item.start) })
  }

  let conflicts = 0
  for (const [groupKey, items] of groups) {
    if (items.length < 2) continue
    const distinct = new Set(items.map(item => item.value))
    if (distinct.size < 2) continue
    // 同一句里出现多个值，通常是并列描述（分渠道 / 分产品 / 前后对比），不是自相矛盾。
    // 只有**跨句子**还打架，才说明这份文件的口径有问题。
    const distinctSentences = new Set(items.map(item => item.sentence))
    if (distinctSentences.size < 2) continue
    conflicts += 1
    const [key, unit] = groupKey.split('|')
    const last = items[items.length - 1]
    hits.push(hitOf(ctx, {
      rule: 'B4-数值冲突',
      dimension: 'B4',
      severity: 3,
      start: last.start,
      end: last.start + last.text.length,
      why: `「${key}」在同一份文件里出现了 ${distinct.size} 个不同的数值：${[...distinct].join(' / ')}${unit}。读者无法判断哪个作准。`,
      fix: '统一口径；若确是不同时点/不同范围，分别写明限定条件。',
    }))
  }

  // ② 合计 ≠ 分项之和
  for (const paragraph of ctx.paragraphs) {
    if (!/(合计|总计|共计|小计|\btotal\b)/iu.test(paragraph.text)) continue
    const local = numbers.filter(item => item.start >= paragraph.start && item.start < paragraph.end)
    if (local.length < 3) continue
    const totalItem = local[local.length - 1]
    const addends = local.filter(item => item !== totalItem && item.unit === totalItem.unit)
    if (addends.length < 2) continue
    const sum = addends.reduce((acc, item) => acc + item.value, 0)
    const tolerance = Math.max(Math.abs(totalItem.value) * 0.01, 0.01)
    if (Math.abs(sum - totalItem.value) <= tolerance) continue
    hits.push(hitOf(ctx, {
      rule: 'B4-合计不符',
      dimension: 'B4',
      severity: 3,
      start: totalItem.start,
      end: totalItem.start + totalItem.text.length,
      why: `合计写作 ${totalItem.value}${totalItem.unit}，但同段分项之和为 ${Number(sum.toFixed(4))}${totalItem.unit}，差 ${Number(Math.abs(sum - totalItem.value).toFixed(4))}。`,
      fix: '核对分项或合计；若含未列出的其他项，请补上"其他"一行。',
    }))
  }

  // ③ 期限早于起始
  const deadlines = [...source.matchAll(/(?:截止|期限|DDL|deadline)[^0-9]{0,8}((?:19|20)\d{2}[-/年]\d{1,2}(?:[-/月]\d{1,2})?)/giu)]
  const starts = [...source.matchAll(/(?:启动|开始|开工|kick-?off|start)[^0-9]{0,8}((?:19|20)\d{2}[-/年]\d{1,2}(?:[-/月]\d{1,2})?)/giu)]
  if (deadlines.length > 0 && starts.length > 0) {
    const toDate = raw => {
      const parts = raw.split(/[-/年月]/u).map(Number)
      return parts[0] * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0)
    }
    const deadlineValue = toDate(deadlines[0][1])
    const startValue = toDate(starts[0][1])
    if (deadlineValue < startValue) {
      hits.push(hitOf(ctx, {
        rule: 'B4-时限倒挂',
        dimension: 'B4',
        severity: 2,
        start: deadlines[0].index,
        end: deadlines[0].index + deadlines[0][0].length,
        why: `截止日期（${deadlines[0][1]}）早于启动日期（${starts[0][1]}）—— 时序不成立。`,
        fix: '核对两个日期；若确实"先承诺后启动"，请说明已发生的时间线。',
      }))
    }
  }

  // ── 没找到 ≠ 没问题 ──────────────────────────────────────────────
  //
  // 本维只有三类检查：同指标数值冲突 / 合计与分项不符 / 时限倒挂。
  // 而「PartsTech 是最佳首选」与「优先级表把它排在 P2」这种**纯文字的优先级冲突**、
  // 「挂牌价能否代表群体支付意愿」这种**推论跨越**、以及"识别到风险后方案有没有改"，
  // 规则层根本没有判断能力。
  //
  // 过去这里在零命中时返回 severity: 0，报告于是印出"逻辑一致性：未发现问题"。
  // **那是在撒谎** —— 而且是最坏的一种：读者会因此直接跳过这一项。
  // 现在：命中就照常出分（命中带行号，是可定位的真证据）；零命中一律判 insufficient。
  if (hits.length === 0) {
    return {
      state: 'insufficient',
      reason: '本地规则只能核对数值口径（同指标不同值 / 合计与分项 / 时限先后）。'
        + `本次查了 ${numbers.length} 个带单位数值、${groups.size} 组同指标聚合、${ctx.paragraphs.length} 段合计关系，数值层面均未发现冲突；`
        + '但文字层面的论证冲突（推论跨越、对象外推、优先级前后不一致、风险未改变方案）无法由规则判定。'
        + '零命中只说明"数值没打架"，不说明"逻辑一致"。',
      severity: 0,
      hits: [],
      summary: '数值口径未发现冲突；文字论证层面本工具未评估。',
      note: '要判论证关系，需要具备语义判断能力的评审 —— 见报告「未能评估」一节。',
    }
  }

  const severity = clamp(Math.max(...hits.map(hit => hit.severity)), 0, 4)
  return {
    severity,
    hits: hits.slice(0, 12),
    summary: `发现 ${hits.length} 处一致性冲突（数值冲突 ${conflicts} 处）。`,
  }
}

function evaluateB5(ctx) {
  const hasDecision = DECISION_MARK.test(ctx.text)
  const hasOptions = OPTION_MARK.test(ctx.text)
  const hasCompare = COMPARE_MARK.test(ctx.text)
  const hits = []
  let severity = 0

  if (!hasDecision) {
    severity = 2
    hits.push(hitOf(ctx, {
      rule: 'B5-无取舍代价',
      dimension: 'B5',
      severity,
      start: 0,
      end: Math.min(60, ctx.text.length),
      why: '全文没有出现风险、代价、成本、限制、未决或假设 —— 一份"只有好处没有代价"的文件，接收者无法据此判断该不该做。',
      fix: '补一节：这个做法的代价、依赖与失败模式；以及还有哪些事没定。',
      note: `已检查范围：全文 ${ctx.text.length} 字。`,
    }))
  }

  if (hasOptions && !hasCompare) {
    severity = clamp(severity + 1, 0, 4)
    const match = OPTION_MARK.exec(ctx.text)
    hits.push(hitOf(ctx, {
      rule: 'B5-有选项无比较',
      dimension: 'B5',
      severity: 2,
      start: match?.index ?? 0,
      end: (match?.index ?? 0) + (match?.[0].length ?? 0),
      why: '列出了多个选项，但没有对比维度、优劣与适用条件 —— 选择权被原样退回给接收者。',
      fix: '加一张对比：成本 / 周期 / 风险 / 适用前提，并给出推荐与理由。',
    }))
  }

  // 规则层能**确定判定**的只有两种"缺"：
  //   ① 全文一次都没提代价 / 风险 / 限制 / 未决 / 假设  → 确凿缺陷，照常出分；
  //   ② 列了选项却没有比较维度                          → 确凿缺陷，照常出分。
  //
  // 反过来，"文中出现了风险表述"**推不出**"决策支持到位"。
  // 真正该问的是：「识别到这个风险之后，渠道选择、投入规模、推进条件发生了什么变化？」
  // 这需要判断风险与方案变更之间的因果关系，规则层判不了。
  // 所以零命中同样判 insufficient —— 别把"我没看"印成"没问题"。
  if (hits.length === 0) {
    return {
      state: 'insufficient',
      reason: '原文确实出现了取舍/代价/风险/限制一类表述，但本地规则只能确认"写了什么词"，'
        + '无法判断"这项风险有没有真的改变方案"（渠道选择、投入规模、宣传范围、推进条件是否随之变化）。'
        + '零命中不等于决策支持充分。',
      severity: 0,
      hits: [],
      summary: '有代价表述；「风险是否进入决策」这一层未评估。',
      note: '要判"风险→方案变更"的因果，需要语义评审。',
    }
  }

  return {
    severity,
    hits: hits.slice(0, 8),
    summary: '全文没有出现风险、代价、成本、限制、未决或假设 —— 只有好处没有代价。',
  }
}

/** 这些体裁本身就应当承载动作 —— 全篇无动作项算缺陷，不算"不适用"。 */
const REQUIRES_ACTION = new Set(['proposal', 'plan', 'report', 'minutes'])

function evaluateB6(ctx, docType) {
  // ★ 体裁未识别时，本维改为**只报数、不判定**（state: 'observed'）。
  //   「有没有动作项 / 有没有责任人 / 有没有期限」跟体裁无关，是纯可数事实；
  //   与体裁有关的只是「缺了算不算缺陷」。把这两件事拆开，
  //   就不会再出现「因为不知道这是什么文件，所以连有没有责任人都不能说」。
  const untyped = docType === 'generic'

  const hasAction = ACTION_MARK.test(ctx.text)
  if (!hasAction) {
    if (untyped) {
      return {
        state: 'observed',
        reason: '体裁未识别：本维只报数、不判定。',
        severity: 0,
        hits: [],
        summary: '全文未检出动作类动词 —— 这份文件不派活。（仅计数，不据此扣分）',
      }
    }
    if (!REQUIRES_ACTION.has(docType)) {
      return {
        state: 'not-applicable',
        reason: '全文没有出现动作类要求（提交/完成/上线/评审等）—— 这份文件不派活，不判执行完整性。',
        severity: 0,
        hits: [],
        summary: '无动作要求，本维不适用。',
      }
    }
    return {
      severity: 2,
      hits: [hitOf(ctx, {
        rule: 'B6-无动作项',
        dimension: 'B6',
        severity: 2,
        start: 0,
        end: Math.min(60, ctx.text.length),
        why: `这是一份「${docType === 'minutes' ? '会议纪要' : docType === 'report' ? '报告' : docType === 'plan' ? '计划' : '方案'}」，`
          + '但全文没有任何动作项（做什么 / 谁做 / 何时交）—— 接收者读完不知道该动什么。',
        fix: '补一节执行：动作 + 责任人 + 期限 + 交付物；确实无需行动就明写"本次无待办"。',
        note: `已检查范围：全文 ${ctx.text.length} 字，未找到动作类动词。`,
      })],
      summary: '该体裁应含动作项，但全篇未找到。',
    }
  }

  const hasOwner = OWNER_MARK.test(ctx.text)
  const hasTime = TIME_MARK.test(ctx.text)
  const hits = []
  let severity = 0

  if (!hasOwner && !hasTime) severity = 3
  else if (!hasOwner || !hasTime) severity = 2

  if (!hasOwner) {
    hits.push(hitOf(ctx, {
      rule: 'B6-缺责任人',
      dimension: 'B6',
      severity: 2,
      start: 0,
      end: Math.min(60, ctx.text.length),
      why: '文中要求做事，但没有写明谁负责 —— 责任悬空时，行动默认会落到发送方身上（这正是"工作空转"）。',
      fix: '每条动作后面写责任人或责任部门，哪怕是"待指派 · 需 X 确认"。',
      note: `已检查范围：全文 ${ctx.text.length} 字，未找到负责/牵头/owner/待办等标记。`,
    }))
  }
  if (!hasTime) {
    hits.push(hitOf(ctx, {
      rule: 'B6-缺期限',
      dimension: 'B6',
      severity: 2,
      start: 0,
      end: Math.min(60, ctx.text.length),
      why: '文中要求做事，但没有写期限 —— 没有时点的动作等于没有排期。',
      fix: '补上日期或"何时前"；确实未定就写"待定 · 需 X 决定"。',
      note: `已检查范围：全文 ${ctx.text.length} 字，未找到截止/期限/日期/DDL 等标记。`,
    }))
  }

  return {
    state: untyped ? 'observed' : undefined,
    severity: untyped ? 0 : severity,
    hits: hits.slice(0, 8),
    summary: `责任人标记${hasOwner ? '有' : '无'}、期限标记${hasTime ? '有' : '无'}`
      + (untyped ? '（体裁未识别，仅报数不扣分）' : '') + '。',
  }
}

/* ───────────────────────────── 调度 ────────────────────────────────── */

const EVALUATORS = {
  A1: evaluateA1,
  A2: evaluateA2,
  A3: evaluateA3,
  A4: evaluateA4,
  A5: evaluateA5,
  B1: evaluateB1,
  B2: evaluateB2,
  B3: evaluateB3,
  B4: evaluateB4,
  B5: evaluateB5,
  B6: evaluateB6,
}

/**
 * 评估全部维度。
 * @returns {{dimensions: object[], docType: string, ruleSetVersion: string, docTypeLabel: string}}
 */
export function evaluateAll(text, { docType = 'auto' } = {}) {
  const ctx = buildContext(text)
  const resolvedType = docType === 'auto' ? inferDocType(text) : docType
  const blocklist = NOT_APPLICABLE[resolvedType] ?? {}

  const dimensions = DIMENSIONS.map(dimension => {
    if (blocklist[dimension.id] !== undefined) {
      return {
        ...dimension,
        state: 'not-applicable',
        reason: blocklist[dimension.id],
        severity: 0,
        hits: [],
        summary: '本维对该文档类型不适用。',
      }
    }
    const result = EVALUATORS[dimension.id](ctx, resolvedType)
    const state = result.state ?? 'scored'
    return {
      ...dimension,
      state,
      reason: result.reason,
      severity: state === 'scored' ? clamp(result.severity ?? 0, 0, 4) : 0,
      hits: result.hits ?? [],
      note: result.note,
      summary: result.summary,
    }
  })

  return {
    docType: resolvedType,
    docTypeLabel: DOC_TYPES.find(item => item.id === resolvedType)?.label ?? resolvedType,
    ruleSetVersion: RULESET_VERSION,
    dimensions,
    stats: ctx.stats,
    sentenceCount: ctx.sentences.length,
    paragraphCount: ctx.paragraphs.length,
  }
}
