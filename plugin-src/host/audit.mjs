/**
 * 编排层 —— 解析 → 评分 → 提炼 → 出报告。
 *
 * 这一层是**唯一**把三段串起来的地方，因此也承担三件事：
 *   ① 输入门禁（大小 / 类型 / 空文件）
 *   ② 覆盖判定（解析不足就不给总分，且把"为什么不足"写进报告）
 *   ③ 报告可复现（规则集版本 + 引擎版本 + 参数快照都写进报告末尾）
 */

import { distill, renderDistillMarkdown } from './distill.mjs'
import { evaluateLayers, hintCells, whyUnscored, CELLS, CELL_DISPLAY_ORDER, CONDITIONS, DISPLAY_ORDER, LAYERS, SCORE_ANCHORS, SCORE_MAX, GAP_AT } from './layers.mjs'
import { adviceOf } from './advice.mjs'
import { verifyReview } from './review.mjs'
import { PROTOCOL } from './rubric.mjs'
import { auditObligations, renderObligationMarkdown } from './obligations.mjs'
import { parseFile, ParseError } from './parse.mjs'
import { DOC_TYPES, RULESET_ENGINE, RULESET_VERSION, evaluateAll, inferDocType } from './rules.mjs'
import { computeScores, countsTowardScore, SEVERITY_LABEL } from './score.mjs'

/** 引擎版本 —— 与规则集版本分开：引擎改计算流程，规则集改判定内容。 */
export const ENGINE_VERSION = '0.7.17'

const DEFAULTS = {
  maxFileBytes: 20 * 1024 * 1024,
  maxChars: 600000,
  minParseCoverage: 0.7,
  minEvalCoverage: 0.6,
  includeSnippets: true,
}

const pct = value => `${(value * 100).toFixed(0)}%`

/**
 * 取舍表述 —— 用它判断「这份文件有没有做过选择」。
 *
 * 决策不是"列了哪些选项"，是"排除了哪些选项"。一份通篇讲"可以、适合、优先"、
 * 却从不写"暂缓、放弃、排除"的文件，交给读者的是一个候选池，不是一个决定。
 *
 * 这是**词表判断**，只能说明"文里有没有这类词"，不能说明取舍做得对不对。
 * 所以它只作为决策层面的一项二值缺口，不单独构成结论。
 */
const TRADEOFF_MARK = /(暂不|暂缓|不做|放弃|排除|不选|不主推|不进入|不投入|延后|搁置|取舍|砍掉|放弃或延后)/u

/**
 * 组装交付承接台账。四种状态**不得互相顶替**：
 *
 *   null                     —— 没给任务：本次不做承接评价（不给 B，也不假装给）
 *   {status:'pending'}       —— 给了任务但没给义务表：义务要由语义方拆，插件不猜
 *   {status:'error'}         —— 义务表不合契约（缺任务原文 / 字段不合法 / 引文对不上）
 *   {status:'ok'}            —— 台账成立
 *
 * 「没给任务」≠「判不了」≠「判了没问题」。这三者混起来，就是 0.2.0 在 B4/B5 上犯的错。
 */
function buildLedger({ task, obligations, docText }) {
  const hasTask = typeof task === 'string' && task.trim() !== ''
  const hasObligations = Array.isArray(obligations) && obligations.length > 0

  if (!hasObligations) {
    if (!hasTask) return null
    return {
      status: 'pending',
      task,
      message: '已收到任务原话，但**没有收到义务表**。本插件不自己拆义务 —— '
        + '从文档倒推出来的义务表本质是"最佳实践清单"，用它判承接会把任务缺口洗成"已满足"。',
      hint: '由具备语义判断能力的一方（对话中的模型）按任务拆出义务，再连同原文一并提交。',
    }
  }

  try {
    const report = auditObligations({
      docText,
      task,
      basis: hasTask ? 'task' : 'self-stated',
      obligations,
      sourceMode: 'inline',
    })
    return { status: 'ok', report }
  } catch (error) {
    return {
      status: 'error',
      task: hasTask ? task : '',
      error: {
        code: error?.code ?? 'UNKNOWN',
        message: error?.message ?? String(error),
        hint: error?.hint,
      },
    }
  }
}

/**
 * 完整审计。
 * @param {{buffer: Buffer, filename: string, docType?: string, level?: string,
 *          task?: string, obligations?: object[], source?: string, config?: object}} input
 */
export function audit(input) {
  const config = { ...DEFAULTS, ...(input.config ?? {}) }
  const filename = String(input.filename ?? '未命名')
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer ?? [])
  const startedAt = Date.now()

  if (buffer.length > config.maxFileBytes) {
    throw new ParseError('FILE_TOO_LARGE',
      `文件 ${(buffer.length / 1024 / 1024).toFixed(1)} MB 超过上限 ${(config.maxFileBytes / 1024 / 1024).toFixed(0)} MB。`, {
        hint: '在 profile 的 cordis.patch.yml 里调大 maxFileBytes，或先拆分/另存为更小的文件。',
        stage: 'gate',
      })
  }

  const parsed = parseFile({ buffer, filename }, { maxChars: config.maxChars })
  if (parsed.text.trim() === '') {
    throw new ParseError('NO_TEXT', '解析成功但没有任何文本内容，无法评分。', {
      hint: '若这是扫描件 PDF，本插件不做 OCR —— 请先转成可复制文本的 PDF 或提供 .docx。',
      stage: 'parse',
    })
  }

  const evaluation = evaluateAll(parsed.text, { docType: input.docType ?? 'auto' })
  const scores = computeScores(evaluation, {
    parseCoverage: parsed.coverage,
    minParseCoverage: config.minParseCoverage,
    minEvalCoverage: config.minEvalCoverage,
    parseMode: parsed.parseMode,
  })

  // ── 模块版本一致性闸门 ─────────────────────────────────────────────
  // 热重载只重载改动过的文件时，会出现「新 audit.mjs + 旧 rules.mjs」的混装：
  // 报告的版本号是新的，算它的是旧的，而且**不报任何错**。
  // 与其给一个查不出源头的错分，不如不出分并说清怎么修。
  const consistency = {
    ok: RULESET_ENGINE === ENGINE_VERSION,
    engine: ENGINE_VERSION,
    rulesEngine: RULESET_ENGINE ?? '(缺失：rules.mjs 为旧版本)',
  }
  if (!consistency.ok) {
    for (const index of [scores.indexA, scores.indexB]) {
      index.value = null
      index.withheld = true
      index.withheldReason = `模块版本不一致：规则集是给引擎 ${consistency.rulesEngine} 构建的，当前引擎是 ${consistency.engine}。`
        + '通常是热重载残留（只重载了部分文件）。请重启 DSH 后重跑 —— 这一版的分不可信。'
      index.verdict = { band: '未定', text: '模块版本不一致，不出分' }
    }
    scores.coverage.withheldTotal = true
    scores.coverage.withheldReason = '模块版本不一致（规则集与引擎对不上），按一致性闸门不出分。'
    scores.headline = {
      available: false,
      text: `本次不出分：规则集（${consistency.rulesEngine}）与引擎（${consistency.engine}）版本不一致，`
        + '报告上的版本号不可信。请重启 DSH 后重跑。',
    }
  }

  const distillation = distill(parsed.text, { level: input.level ?? 'summary' })

  const ledger = buildLedger({
    task: input.task,
    obligations: input.obligations,
    docText: parsed.text,
  })

  // ★ 判断只能有**一个来源**。
  //   之前 markdown 在渲染时自己算一遍，面板却读 scores.headline（A 口径）——
  //   于是同一份报告出现两个结论：markdown 第一节「Slop 特征：显著」，
  //   面板首屏大号「11.3 · 干净」。用户当然只信更大更靠前的那个。
  //   现在算一次、放进 report，markdown 与面板都从这里渲染。
  const observable = computeObservable(distillation, scores.indexA, ledger?.status ?? null, parsed.text)

  // ── 四层十二格（0.7.0：判定来自通读全文的评审记录）────────────────
  //
  // ★ 0.6.0 的教训：引擎"从已有证据推分"，推出来的其实是四个标量的比值
  //   （主张同句无依据比例 / 动作项缺责任人比例 / 缺期限比例 / 目的词状态）。
  //   一条跨行矛盾、一次把一句话拆成两条动作项的切分错误，都能让它给出反向答案。
  //   所以 0.7.0 把判定权交回**读过全文的那一方**，引擎只做三件事：
  //   登记原文、核对引文与状态、算分出报。
  //
  // ★ 没有 review 就没有分。允许传 `cells`（老路径）只是为了不静默丢弃调用方提交的东西；
  //   它同样要过 verifyReview —— 没有理解摘要、没有引文，一样不出分。
  const reviewInput = input.review !== undefined && input.review !== null
    ? input.review
    : (Array.isArray(input.cells) && input.cells.length > 0
      ? { cells: input.cells, basis: 'none', gaps: input.gaps, pending: input.pending }
      : null)
  const reviewVerdict = reviewInput === null
    ? {
      ok: false,
      code: 'review-required',
      message: '没有收到评审记录：分数必须来自对全文的判定，引擎不代判。',
      cells: [],
      rejects: [],
      warnings: [],
      stats: { rated: 0, rejected: 0, pending: 12, na: 0, evidenceCount: 0, lineSpread: null },
    }
    : verifyReview({ review: reviewInput, docText: parsed.text })

  const gapsInput = Array.isArray(reviewInput?.gaps) ? reviewInput.gaps : (Array.isArray(input.gaps) ? input.gaps : [])
  const pendingInput = Array.isArray(reviewInput?.pending) ? reviewInput.pending : (Array.isArray(input.pending) ? input.pending : [])

  const layers = evaluateLayers({ cells: reviewVerdict.cells, gaps: gapsInput, pending: pendingInput })
  layers.source = reviewVerdict.ok ? 'review' : 'none'
  // ★ 0.7.13：工作缺口 —— 同一事实已由模型合并成一条，格降为证据位置。
  layers.shortfalls = reviewVerdict.shortfalls ?? []
  layers.review = {
    ok: reviewVerdict.ok,
    code: reviewVerdict.code ?? 'ok',
    message: reviewVerdict.message ?? '',
    docId: reviewVerdict.docId ?? { claimed: null, actual: '', match: null },
    understanding: reviewVerdict.understanding ?? { claims: [], done: [], open: [], dropped: [], total: 0 },
    rejects: reviewVerdict.rejects ?? [],
    warnings: reviewVerdict.warnings ?? [],
    stats: reviewVerdict.stats ?? { rated: 0, rejected: 0, pending: 12, na: 0, evidenceCount: 0, lineSpread: null },
    basis: reviewInput?.basis ?? 'none',
    basisNote: String(reviewInput?.basisNote ?? ''),
    // 谁给出的判定 —— 报告抬头要印出来，否则"选的模型"和"用的模型"对不对无从核。
    model: (reviewInput?.model !== null && typeof reviewInput?.model === 'object') ? reviewInput.model : null,
  }
  layers.advice = adviceOf({
    cells: layers.cells,
    gaps: gapsInput,
    pending: pendingInput,
    composite: layers.composite,
    shortfalls: layers.shortfalls,
  })
  layers.derivation = null
  layers.machineCellsRated = 0

  const report = {
    ok: true,
    engineVersion: ENGINE_VERSION,
    ruleSetVersion: RULESET_VERSION,
    consistency,
    filename,
    source: input.source ?? 'upload',
    file: {
      format: parsed.format,
      label: parsed.label,
      bytes: buffer.length,
      chars: parsed.chars,
      truncated: parsed.truncated,
      parseMode: parsed.parseMode,
    },
    parse: {
      coverage: parsed.coverage,
      warnings: parsed.warnings,
    },
    docType: {
      id: evaluation.docType,
      label: evaluation.docTypeLabel,
      inferred: (input.docType ?? 'auto') === 'auto',
    },
    stats: evaluation.stats,
    scores,
    layers: {
      ...layers,
      hints: hintCells(evaluation.dimensions),
      weightsNote: '权重 20 / 35 / 35 / 10 为初案，未经校准。**高分 = 交付质量好**；'
        + '与 0.3.x（越高越差）方向相反，跨版本的分数不可比。',
    },
    observable,
    ledger,
    dimensions: evaluation.dimensions.map(dimension => ({
      id: dimension.id,
      label: dimension.label,
      index: dimension.index,
      weight: dimension.weight,
      state: dimension.state,
      severity: dimension.severity,
      severityLabel: dimension.state === 'scored' ? SEVERITY_LABEL[dimension.severity] : '—',
      // 面板与报告都读这一格：严重度印不印，由宿主算一次（score.mjs 的 countsTowardScore）。
      counts: countsTowardScore(dimension),
      reason: dimension.reason,
      summary: dimension.summary,
      note: dimension.note,
      hits: config.includeSnippets ? dimension.hits : dimension.hits.map(hit => ({ ...hit, snippet: '〔已按隐私设置隐去原文〕' })),
    })),
    distillation: {
      level: distillation.level,
      levelLabel: distillation.levelLabel,
      method: distillation.method,
      elements: distillation.elements,
      evidenceAndLimits: distillation.evidenceAndLimits,
      questions: distillation.questions,
      fidelity: distillation.fidelity,
      protectedUnits: distillation.protectedUnits,
      compression: distillation.compression,
    },
    params: {
      maxChars: config.maxChars,
      minParseCoverage: config.minParseCoverage,
      minEvalCoverage: config.minEvalCoverage,
      includeSnippets: config.includeSnippets,
      docTypeInput: input.docType ?? 'auto',
      level: input.level ?? 'summary',
      taskProvided: typeof input.task === 'string' && input.task.trim() !== '',
      obligationCount: Array.isArray(input.obligations) ? input.obligations.length : 0,
      cellsProvided: Array.isArray(input.cells) ? input.cells.length : 0,
      reviewProvided: reviewInput === null ? 0 : 1,
      reviewCode: layers.review.code,
      pendingCount: Array.isArray(input.pending) ? input.pending.length : 0,
    },
    elapsedMs: Date.now() - startedAt,
  }

  // ★ F60/F61：B3 与 B6 的计数不得另起一套。
  //   它们各自 test 全文词表，会与逐句统计打架 —— 0.3.1 的报告里
  //   「动作项 12 / 12 无责任人」（第一节）与「责任人标记有」（第六节）同时存在，
  //   读者只能信一个，而信哪个都是错的。
  //   现在结论口径只有一处（observable），B 维度只保留状态，摘要指向第一节。
  const counted = report.observable.counted
  for (const dimension of report.dimensions) {
    if (dimension.id === 'B3') {
      dimension.summary = `主张 ${counted.claims} 条中 ${counted.noSupport} 条同句无依据（口径见第一节）。`
    }
    if (dimension.id === 'B6') {
      dimension.summary = `动作 ${counted.actions} 条：需判缺项 ${counted.judgeable} 条（${counted.noOwner} 条无责任人、`
        + `${counted.noDue} 条无期限），对方义务 ${counted.obligations} 条不计（口径见第一节）。`
    }
  }

  // 0.3.x 旧章节默认不渲染（见 renderLegacySections 的说明）。
  report.legacySections = input.legacySections === true
  report.markdown = renderAuditMarkdown(report)
  return report
}

/** 只评分不提炼（面板"快速评分"用；也便于单测）。 */
export function scoreOnly(input) {
  const result = audit(input)
  return { ...result, markdown: undefined }
}

/**
 * 可观测要素 —— **只计数，不下判**。
 *
 * ★ 为什么要单列这一层（0.2.6 的核心修正）：
 *   0.2.5 撤掉 B 之后，首页只剩 A 的「表达体检 11.3（干净）」。
 *   而 A 量的是**文本属性**（套话 / 重复 / 模板化 / 模糊），
 *   Slop 量的是**「任务要求 − 实际交付」的差值**。两者不是同一个量纲：
 *   一份读起来专业、数字密、却不知道要批什么的文件，A 分照样很低。
 *   于是工具对真正的那个问题，给出了一个**反向答案**。
 *
 *   但「决策与执行有没有落到可执行的形式」里，有一部分是**可数的**：
 *   动作有没有责任人、有没有期限、主张有没有依据标记、第几句才说目的。
 *   这四项不需要任务基准，也不需要语义理解 —— 只需要数。
 *   而它们恰好是「把工作转嫁给接收者」的可观测骨架。
 *
 *   所以：能判的判，判不了的说判不了，**能数的照实数出来**；数出来的东西不下判。
 *   这一层永远只报事实 —— 一旦它开始下判，就变成了又一个爱撒谎的分数。
 */
function computeObservable(distillation, indexA, ledgerStatus, docText) {
  const actions = distillation?.elements?.actions?.items ?? []
  const claims = distillation?.elements?.claims?.items ?? []
  const purpose = distillation?.elements?.purpose ?? { status: '未明示', quotes: [] }

  // ★ 0.3.11：分母只算**需要判缺项**的动作项。
  //   对方义务（「经销商须…」「Distributor shall…」「Shipping cost borne by Distributor」）
  //   的责任人由条款主语给出，拿"作者没写责任人"去罚它是罚一个不存在的问题。
  //   这正是老板反馈的「没有区分哪些是汇报人要做的，哪些是汇报人阐述的内容」。
  //   `gap` 由 distill 一次算好，这里**不再**按 owner/due 重判一遍。
  const judgeable = actions.filter(item => item.party !== 'other')
  const obligations = actions.filter(item => item.party === 'other')
  const noOwner = judgeable.filter(item => item.owner === '未说明')
  const noDue = judgeable.filter(item => item.due === '未说明')
  const badActions = judgeable.filter(item => item.gap)
  const noSupport = claims.filter(item => item.support !== '同句有依据标记')

  const lineList = items => {
    const lines = [...new Set(items.map(item => item.line).filter(line => Number.isFinite(line)))]
    if (lines.length === 0) return '—'
    return lines.slice(0, 6).map(line => `第 ${line} 行`).join(' / ') + (lines.length > 6 ? ' …' : '')
  }

  const rows = []
  if (judgeable.length > 0) {
    rows.push({ id: 'L1', label: '动作项无责任人', count: `${noOwner.length} / ${judgeable.length}`, where: lineList(noOwner) })
    rows.push({ id: 'L2', label: '动作项无期限', count: `${noDue.length} / ${judgeable.length}`, where: lineList(noDue) })
  }
  if (obligations.length > 0) {
    rows.push({
      id: `L${rows.length + 1}`,
      label: '对方义务（责任人由条款主语给出，不计缺口）',
      count: `${obligations.length} 条`,
      where: lineList(obligations),
    })
  }
  if (claims.length > 0) {
    rows.push({ id: `L${rows.length + 1}`, label: '主张同句无依据标记', count: `${noSupport.length} / ${claims.length}`, where: lineList(noSupport) })
  }
  rows.push({
    id: `L${rows.length + 1}`,
    label: '目的陈述',
    count: purpose.status,
    where: purpose.quotes?.[0]?.line === undefined ? '全文未检出' : `第 ${purpose.quotes[0].line} 行`,
  })

  // ★ 结论强度必须由**实际完成了什么检测**决定，不由计数决定。
  //
  //   0.2.9 用计数直接判「Slop 特征：显著 —— 决策与执行没有落到可执行的形式」，
  //   而同一次报告后面写着「本次没有交付承接结论，本报告只做表达体检与结构检查」。
  //   **两组表述不能同时作为正式结论。**「这些是计数，不是判定」也救不回来 ——
  //   首页已经用这些计数完成了定性，免责声明只是给它兜底。
  //
  //   规则层能做的只有「扫描 + 计数」：判断"任务有没有被接住"必须有任务基准；
  //   判断"决策是否有效"必须看任务要求与实际交付的差。两者都不在规则层能力内。
  //   所以档位由**检测完成度**决定，不由计数多寡决定。
  const leads = badActions.length + noSupport.length

  // ── 执行缺口（C）：可数条目的覆盖率，**不是判断** ──
  // 0.3.1 的报告里，同一份文件出现「12 / 12 无责任人」与「责任人标记有」两种说法 ——
  // 根因是计数有两个来源（逐句抽取 vs 全文词表）。这里把结论口径收敛到一处：
  // §一 的表格、§六 的摘要、这个分数，全部来自同一组 counted。
  // ── 三个可计算层面 + 加权 Slop 得分 ──
  //
  // 老板要「首行一个醒目的 Slop 分，值越大越重，用可计算的结果加权平均」。
  // 这三个层面必须全部**可数**，不引入任何语义判断：
  //
  //   表达（A）  规则集算出的表达水分（早已有）
  //   执行（C）  动作项里缺责任人 / 期限的比例
  //   决策（D）  主张里缺依据标记的比例，外加两项二值缺口：
  //               · 目的未明示（没说清要谁决定什么）
  //               · 全文没有任何取舍表述（只列了可能性，没做选择）
  //
  // 分数**不等于结论**。它量的是「可计算层面的 Slop 程度」，
  // 不回答「任务有没有被接住」—— 那需要任务基准，只有台账能给。
  const PURPOSE_MISSING = purpose.status !== '明示'
  const NO_TRADEOFF = !TRADEOFF_MARK.test(String(docText ?? ''))

  const counted = {
    actions: actions.length,
    judgeable: judgeable.length,
    obligations: obligations.length,
    claims: claims.length,
    noOwner: noOwner.length,
    noDue: noDue.length,
    noSupport: noSupport.length,
    badActions: badActions.length,
    purposeMissing: PURPOSE_MISSING,
    noTradeoff: NO_TRADEOFF,
  }

  // 执行缺口：**需要判缺项**的动作里没写全的比例。
  // 没有这类动作项 → 不出分（不是 0 分）：要么全文没动作，要么全是对方义务。
  const executionGap = judgeable.length === 0
    ? null
    : Math.round((100 * badActions.length) / judgeable.length)

  // 决策缺口：(无依据主张 + 目的未明示 + 无取舍) / (主张数 + 2 个二值项)
  const decisionGap = Math.round(
    (100 * (noSupport.length + (PURPOSE_MISSING ? 1 : 0) + (NO_TRADEOFF ? 1 : 0))) / (claims.length + 2),
  )

  const layers = [
    { key: 'A', label: '表达', weight: 0.2, value: (indexA?.value === null || indexA?.value === undefined) ? null : indexA.value },
    { key: 'C', label: '执行', weight: 0.4, value: executionGap },
    { key: 'D', label: '决策', weight: 0.4, value: decisionGap },
  ]
  const usable = layers.filter(layer => layer.value !== null)
  const weightSum = usable.reduce((sum, layer) => sum + layer.weight, 0)
  const slopScore = weightSum === 0
    ? null
    : Math.round(usable.reduce((sum, layer) => sum + layer.value * layer.weight, 0) / weightSum)

  const band = slopScore === null ? '不出分'
    : slopScore <= 20 ? '干净'
      : slopScore <= 40 ? '轻度'
        : slopScore <= 60 ? '中度'
          : slopScore <= 80 ? '高' : '很高'

  // 三层的"一句话概括" —— 与 markdown、面板同源，避免又出现两套说法。
  // 每句都是**按数拼出来的固定句式**，不做推理。
  const executionNote = executionGap === null
    ? (actions.length === 0
      ? '本次没有抽取到动作项，执行层面不适用。'
      : `抽出的 ${actions.length} 条全部是对方/第三方义务（责任人由条款主语给出），`
        + '按"作者没写责任人/期限"来判不成立 —— 执行层面本次不适用，不扣分。')
    : (badActions.length === judgeable.length
      ? `需要判缺项的动作 ${judgeable.length} 条，没有一条写全`
        + `（${noOwner.length} 条缺责任人、${noDue.length} 条缺期限）。`
      : `需要判缺项的动作 ${judgeable.length} 条中 ${noOwner.length} 条缺责任人、${noDue.length} 条缺期限。`)
      + (obligations.length === 0 ? '' : `另有 ${obligations.length} 条对方义务，责任人已由条款主语给出，不计入缺口。`)

  const decisionNote = `主张 ${counted.claims} 条里 ${counted.noSupport} 条同句没有依据标记`
    + (PURPOSE_MISSING ? '；全文没有明示目的，读完不知道该批什么' : '')
    + (NO_TRADEOFF ? '；也没有任何取舍表述，只列了选项没做选择' : '')
    + '。'

  // ── 三层得分的**扣分依据** ────────────────────────────────────────
  //
  // ★ 老板 0.3.11 反馈：「表达 0 · 执行 100 · 决策 93，执行与决策的扣分项
  //   在证据板块要有体现」。
  //
  //   原来的证据板块只有 A1–A5 / B1–B6 逐维表，而执行（C）与决策（D）根本不按维度拆，
  //   于是首页印了两个大数字，读者翻遍证据页找不到它们是怎么来的。
  //   **一个数不能只在首页出现一次** —— 它必须能就地展开成行号与原因。
  //
  //   这里算一次，markdown 与面板都读 `observable.layerEvidence`，
  //   免得又出现"两处各拼一遍"。表达（A）不在这里：它由 A1–A5 逐维表承载。
  const snippetOf = raw => {
    const text = String(raw ?? '').replace(/\s+/gu, ' ').trim()
    return text.length > 64 ? `${text.slice(0, 61)}…` : text
  }
  const missingOf = item => {
    const ownerGap = item.owner === '未说明'
    const dueGap = item.due === '未说明'
    if (ownerGap && dueGap) return '无责任人与期限'
    return ownerGap ? '无责任人' : '无期限'
  }

  const layerEvidence = [
    {
      key: 'C',
      label: '执行',
      weight: 40,
      value: executionGap,
      note: executionNote,
      basis: judgeable.length === 0
        ? `动作项共 ${counted.actions} 条，其中对方义务 ${counted.obligations} 条 —— 没有需要判缺项的动作，本层不出分。`
        : `动作项共 ${counted.actions} 条：需要判缺项 ${judgeable.length} 条、对方义务 ${counted.obligations} 条；`
          + `缺口 = ${badActions.length} ÷ ${judgeable.length} × 100 = ${executionGap}。`,
      items: badActions.map(item => ({ line: item.line, text: snippetOf(item.action), missing: missingOf(item) })),
    },
    {
      key: 'D',
      label: '决策',
      weight: 40,
      value: decisionGap,
      note: decisionNote,
      basis: `主张 ${claims.length} 条中 ${noSupport.length} 条无依据；`
        + `目的${PURPOSE_MISSING ? '未明示' : '已明示'}；取舍表述${NO_TRADEOFF ? '无' : '有'}；`
        + `缺口 = (${noSupport.length}+${PURPOSE_MISSING ? 1 : 0}+${NO_TRADEOFF ? 1 : 0})`
        + ` ÷ (${claims.length}+2) × 100 = ${decisionGap}。`,
      items: [
        ...noSupport.map(item => ({ line: item.line, text: snippetOf(item.text), missing: '同句无依据标记' })),
        ...(PURPOSE_MISSING
          ? [{ line: purpose.quotes?.[0]?.line ?? null, text: '前 25% 内没有找到目的句', missing: '目的未明示' }]
          : []),
        ...(NO_TRADEOFF
          ? [{ line: null, text: '全文没有"暂不 / 放弃 / 排除 / 延后"这类取舍表述', missing: '无取舍' }]
          : []),
      ],
    },
  ]

  const tier = ledgerStatus === 'ok'
    ? 'assessed'
    : (ledgerStatus === 'pending' || ledgerStatus === 'error' ? 'baseline' : 'scan')

  let verdict
  let reason
  let rowsLabel
  let asksLabel
  if (tier === 'scan') {
    verdict = '未判定：本次只做了规则扫描'
    reason = `扫描到 ${leads} 条**待核实线索**（动作句缺责任人或期限、主张句缺依据标记等），`
      + '但**没有原始任务作基准，无法判断这份交付有没有把任务接住**。'
      + '线索只说明"这里该去核实"，不说明"这里错了"。'
    rowsLabel = '待核实线索（未定性）'
    asksLabel = '建议优先核实的三个方向'
  } else if (tier === 'baseline') {
    verdict = '任务基准已建立，承接评审未完成'
    reason = `扫描到 ${leads} 条待核实线索；任务原话已收到，但还没有义务表，`
      + '所以「有没有把任务接住」这一层仍**未判定**。'
    rowsLabel = '待核实线索（未定性）'
    asksLabel = '建议优先核实的三个方向'
  } else {
    verdict = '已完成任务承接评审'
    reason = '按原始任务拆出关键义务、逐条判定覆盖状态 —— **这一层才是"这份文件能不能用"的答案**。'
      + '下面的计数只作补充，不参与定性。'
    rowsLabel = '可观测要素（补充证据）'
    asksLabel = '关键缺口'
  }

  const value = indexA?.value
  let expressionNote
  if (value === null || value === undefined) {
    expressionNote = '表达层面本次未评估。'
  } else if (value <= 20 && tier === 'assessed') {
    expressionNote = '读起来清楚、数字密度不低 —— **这正是最该警惕的一类 Slop：读起来专业，读完仍不知道该批什么。** 表达干净推不出文件可用。'
  } else if (value <= 20) {
    expressionNote = '表达干净。但它只说明文字本身不含水分，**不说明文件可用** —— 本次没有做任务承接判断。'
  } else {
    expressionNote = '表达层面本身也有水分 —— 它与上面的执行 / 决策缺口是两个独立问题，要分别处理。'
  }

  // ── 最该追问的三件事 ──
  // 顺序**固定**，依据老板给的 Slop 定义：「产出的决策与可落地执行越少，越 Slop」
  //   ⇒ 先问执行，再问决策依据，最后问要你决定什么。
  // 每条措辞都是**按类别写死的模板**，不生成判断。
  const asks = []

  if (badActions.length > 0) {
    asks.push({
      title: `动作项 ${judgeable.length} 条：${noOwner.length} 条无责任人 · ${noDue.length} 条无期限`,
      ask: '首个必要动作，谁在什么时候做到什么程度？',
      where: lineList(badActions),
      why: '缺这一层，方案停在纸上：接收者要么自己派活，要么重新开一次会 —— 这正是"把执行转嫁给接收者"。',
      // ★ 补齐标准不是"字段填满"。补个姓名和日期，错误前提与模糊动作照样在。
      fix: '首个必要动作补齐五项：明确对象、责任人、时间安排、交付物、启动条件。',
      done: '拿到这条安排就能直接开工 —— 不用再问"找谁、什么时候、算做到什么程度"。',
      // S5：补齐标准要成为**判定**，不能只写在"怎么补"里。
      // 判据就是这条 ask 自己的口径：有动作项且全部缺 → 未达到；部分缺 → 部分达到。
      current: badActions.length === judgeable.length ? '未达到' : '部分达到',
    })
  }

  if (noSupport.length > 0) {
    asks.push({
      title: `主张 ${claims.length} 条：${noSupport.length} 条同句无依据标记`,
      ask: '这些结论依据的是什么，够不够支撑这个强度？',
      where: lineList(noSupport),
      why: '结论没有出处，接收者无法判断该不该按它做决定 —— 只能选择全信或重做。',
      fix: '关键决策补足以支持其范围与强度的依据（数据、实测，或明确写出的判据）。',
      done: '结论的强度与依据的强度对得上 —— 依据只支持到"可能"，结论就不写成"已被验证"。',
      current: noSupport.length === claims.length ? '未达到' : '部分达到',
    })
  }

  if (purpose.status !== '明示') {
    asks.push({
      title: purpose.status === '推断' ? '目的要靠读者推断' : '全文没有明示目的',
      ask: '这份文件要谁决定什么？',
      where: purpose.quotes?.[0]?.line === undefined ? '全文未检出' : `第 ${purpose.quotes[0].line} 行`,
      why: '读完不知道该批预算、该选渠道、还是该定时点 —— 决定权被留在读者这边。',
      // ★ 不能写"请在 A 与 B 之间选择"—— 那等于把决定又交回给上级，
      //   正是"工作空转"本身。要求的是：先给出你的选择，再请示批准。
      fix: '先给出推荐选项、取舍理由和执行安排，再标明哪些事项必须上级批准。',
      // S6：验收语从「批或不批」放宽为「不用重新做方案」。
      // 上级围绕具体方案提调整是正常的，把它判成"没做完"就把标准立错了。
      done: '上级可以直接批，或就现有方案提调整，但**不需要重新做一遍方案**。',
      current: '未达到',
    })
  }

  return {
    tier, verdict, reason, rows, asks, expressionNote, leads, rowsLabel, asksLabel,
    slopScore, band, layers, counted, executionGap, decisionGap, executionNote, decisionNote,
    layerEvidence,
  }
}

/** 渲染完整 Markdown 报告。 */
/**
 * 四层十二格的 markdown 段。
 *
 * 首屏必须给出四样：**四层分数 ＋ 推进结论 ＋ 已完成的关键工作 ＋ 最需要补做的事项**。
 * 只给一个综合分，等于把「哪一层拖后腿」藏起来 —— 而那一层才是要动手的地方。
 */
export function renderLayersMarkdown(layers) {
  const out = []
  const push = (...rows) => out.push(...rows)
  const head = layers.headline
  const pendingCells = layers.cells.filter(cell => cell.state === 'undetermined')
  const ratedCells = layers.cells.filter(cell => cell.state === 'rated')
  const naCells = layers.cells.filter(cell => cell.state === 'not-applicable')
  const composite = layers.composite
  const readiness = layers.readiness
  const review = layers.review ?? { ok: false, code: 'review-required', message: '没有收到评审记录。', understanding: { claims: [], done: [], open: [], total: 0 } }

  push('## 〇、四层判分')
  push('')

  // ★ 方向说明**无条件印**，不能只在"出分成功"时才说。
  //   实测：十二格全未评时这一行消失了，读者只看到「四层分数：本次不出」，
  //   于是既不知道四层是越高越好，也不知道它和下面那个「体检得分 67（越高越差）」
  //   是两套相反刻度 —— 方向说明属于口径，不属于结果。
  // ★ 0.7.6：报告是给用户看的，不是给插件维护者看的。
  //   这里只说用户需要知道的一件事：分数朝哪边。
  //   版本号、跨版本可比性属于发布说明，不进报告正文。
  push(layers.legacySections === true
    ? '> **分数越高越好**：100 分表示本阶段该做的工作已经完成。本节之后的旧口径三指数方向相反。'
    : '> **分数越高越好**：100 分表示本阶段该做的工作已经完成。')
  push('')

  // ── 全文理解摘要（必须排在打分之前）──────────────────
  //
  // ★ 顺序是产品的一部分：老板验收的标准是"先给理解摘要，再给四层评分、
  //   主要成果、剩余必要工作和推进结论"。理解摘要排第一，是因为它是
  //   "读完了"的唯一证据 —— 分数是它的结论，不能跑到它前面。
  if (review.ok === true) {
    const understanding = review.understanding ?? { claims: [], done: [], open: [], total: 0 }
    push('### 全文理解摘要')
    push('')
    push('> 判定之前必须先有的东西：作者提出什么、完成了什么、哪些条件仍未成立。'
      + '每条都带原文引文，可回原文逐字核对。')
    push('')
    const block = (title, list) => {
      if (!Array.isArray(list) || list.length === 0) return
      push(`**${title}**`)
      push('')
      for (const item of list) {
        const quotes = item.quote
          .map(entry => `L${entry.line}「${entry.quote.length > 56 ? `${entry.quote.slice(0, 56)}…` : entry.quote}」`)
          .join('；')
        push(`- ${item.text}`)
        push(`  ↳ ${quotes}`)
      }
      push('')
    }
    block('作者提出什么', understanding.claims)
    block('完成了什么', understanding.done)
    block('哪些条件仍未成立', understanding.open)
    if (understanding.total === 0) {
      push('（理解摘要为空 —— 本轮无法确认是否通读过全文。）')
      push('')
    }
  }

  // ── 首屏 ─────────────────────────────────────────────
  const showLayer = value => (value === null || value === undefined ? '—' : value)
  if (head.available) {
    push(`**${DISPLAY_ORDER.map(id => `${LAYERS[id].label} ${showLayer(head.layerDisplays[id])}`).join('　')}**`)
    push('')
    push(`**综合质量分 ${head.display} / 100**`)
    push('')
    // ★ 0.7.7：一个 80 分不说明问题在哪。紧跟着写清"还差几处、是哪几处"，
    //   分数才有落点 —— 否则读者只会记住"80 分，还行"。
    // ★ 0.7.13：首屏报的是**缺口数**，不是格数。
    //   同一件事会同时在几格扣分，按格数说"还差 11 处"就把 3 个格算成了 3 件工作。
    const shortfalls = layers.shortfalls ?? []
    const unfinished = layers.cells.filter(cell => cell.state === 'rated' && typeof cell.score === 'number' && cell.score < GAP_AT)
    if (shortfalls.length > 0) {
      const involved = new Set(shortfalls.flatMap(item => item.cells)).size
      push(`> 本阶段还有 **${shortfalls.length} 项**工作没做完（涉及 ${involved} 个检查点）。清单见下面「工作缺口」。`)
    } else if (unfinished.length > 0) {
      push(`> 还有 ${unfinished.length} 个检查点没到满分 —— 本次评审没有合并同一件事，以下按检查点列。`)
    } else {
      push(`> 十二格里没有低于 ${SCORE_MAX} 分的格 —— 本阶段该做的工作已完成。`)
    }
    if (typeof composite.floor === 'number' && typeof head.display === 'number' && composite.floor < head.display && (composite.floorCells ?? []).length > 0) {
      push(`> ${composite.floorCells.join('、')} 还没有判定 —— 若评为 0 分，综合分低至 ${composite.floor}。`)
    }
  } else {
    push('**四层分数：本次不出**')
    push('')
    push(`原因：${composite.withheldReason}`)
  }
  push('')
  push(`**推进结论：${readiness.text}**`)
  push('')
  // ★ 0.7.13：删掉「最低的一层是 X，要动手先看这一层」。
  //   层分最低 ≠ 该先修它 —— 表达层权重只有 10%，而策略/执行各 35%。
  //   先做什么要看缺口的实际影响（见「工作缺口」与推进结论），不是看哪个层分最低。
  if (composite.weightDiscrimination === false) {
    push('> ⚠️ 四层同分，权重本次**未产生区分** —— 综合分的排序意义有限，看层内哪一格低。')
    push('')
  }
  if (composite.normalized === true) {
    push(`> ${composite.normalizedNote}`)
    push('')
  }
  // ── 评审是否成立 ──────────────────────────────────────
  if (review.ok !== true) {
    push(`> ⛔ **本轮不出分。** ${review.message}`)
    push('')
    push('> 四层十二格的分必须来自"读完并理解了这份文件"的判定。引擎不代判 ——')
    push('> 让引擎自己给分，就是 0.6.0 的老毛病：字段齐全 = 高分，一个词就换一套尺。')
    push('')
    if (review.code === 'review-required') {
      push('**下一步**：`slop_prepare` 拿判定规程与结构图 → 通读全文 → 按 `reviewSchema` 提交 review → 重跑本工具。')
      push('')
      push('> 判定规程（12 格问法与锚点）由 `slop_prepare` 返回，**不印进报告** ——')
      push('> 报告要给的是结论，不是使用说明书。')
      push('')
    }
  }
  if (layers.isEmpty === true) {
    push('> **十二格全部未评。**0–10 由通读全文的一方判定，引擎只负责登记原文、核对引文与算术 ——')
    push('> 运行 `slop_prepare` 拿判定规程，通读后带 `review` 重跑。')
    push('')
  }

  // ── 没有任何判定 → 本节到此为止 ────────────────────────
  //
  // ★ 这一条是实测打回来的：没有 review 时，报告把"四层与算式（全 —）／
  //   十二格表（12 行未评）／0–4 含义／扣分闸四条件／推进结论三段空壳／
  //   怎么提交评审 JSON"全印了一遍，读者看到的是一本使用说明书，
  //   一个结论也没有。**报告是结论，不是说明书。**
  //   规程、锚点、输出格式属于 `slop_prepare` 的返回值，不进报告。
  const hasJudgement = layers.cells.some(cell => cell.state === 'rated' || cell.state === 'not-applicable')
  if (!hasJudgement) {
    push('### 本轮没有判定')
    push('')
    push('**没有层分、没有综合分、没有推进结论。**')
    push('')
    push('这不是"文件有问题"，也不是"文件没问题" —— 是**还没人通读过它**。')
    push('缺判定时给任何分数，都等于拿"我没看"去填一个结论。')
    push('')
    push('下一步：`slop_prepare` → 通读全文 → 交 `review` → 重跑。')
    push('')
    return out
  }

  // ── 四层表 ───────────────────────────────────────────
  push('### 四层与算式')
  push('')
  push('| 层 | 判什么 | 格分 | 层分 | 权重 | 加权 | 含关键缺口 |')
  push('|---|---|---|---:|---:|---:|---|')
  for (const id of DISPLAY_ORDER) {
    const layer = layers.layers.find(item => item.id === id)
    const cells = layer.cells
      .map(cellId => {
        const cell = layers.cells.find(item => item.id === cellId)
        return `${cellId}=${cell.state === 'rated' ? cell.score : (cell.state === 'undetermined' ? '待确认' : (cell.state === 'not-applicable' ? 'N/A' : '未评'))}`
      })
      .join(' · ')
    const weighted = layer.value === null ? '—' : (layer.value * (composite.weightsUsed[id] ?? layer.weight)).toFixed(2)
    push(`| **${layer.label}** | ${layer.question} | ${cells} | ${layer.value === null ? '—' : layer.value} | ${((composite.weightsUsed[id] ?? layer.weight) * 100).toFixed(0)}% | ${weighted} | ${layer.hasCriticalGap === true ? `**是（${layer.criticalGapCells.join('、')}）**` : '否'} |`)
  }
  push(`| | | | | | **${composite.display ?? '—'}** | |`)
  push('')
  // ★ 0.7.7：层分从"平均"改成"最弱格"。这里必须把"平均本来会给多少"印出来 ——
  //   否则读者看不出旧算法把问题洗掉了多少，下一次仍会拿 92 分当结论。
  const meanComposite = layers.layers.reduce((sum, layer) => {
    if (typeof layer.mean !== 'number' || layer.withheld === true) return sum
    return sum + layer.mean * (composite.weightsUsed?.[layer.id] ?? layer.weight)
  }, 0)
  push('> **层分 = 本层最弱的一格**（不是平均）。四层问的都是"这一步该做的做完了吗"——')
  push('> 只要有一格没做完，这一层就是没做完。平均会让两个满分格顶掉一个没做完的格：')
  if (typeof composite.display === 'number' && Math.round(meanComposite) !== composite.display) {
    push(`> 本次按平均算是 **${Math.round(meanComposite)}** 分，按最弱格算是 **${composite.display}** 分 —— 差出来的就是被平均盖住的那部分。`)
  }
  push('> `未评`／`待确认`／`N/A` 不进算式，也不当 0 分或满分（把"我没看"当 0 或当满分，都是撒谎）。')
  push('')

  // ── 工作缺口（0.7.13）──────────────────────────────────
  //
  // ★ 格是证据位置，缺口才是"还剩几件事没做"。
  //   同一件事（比如"该批 5 项还是 6 项"）会同时在 V1/I2/I3 扣分 ——
  //   按格数说"还差 11 处"，就把 3 个格算成了 3 件工作，而这正是要量化的那个差值。
  const shortfalls = layers.shortfalls ?? []
  if (shortfalls.length > 0) {
    push('### 工作缺口')
    push('')
    push(`**共 ${shortfalls.length} 项。**同一件事只算一条；格是用来放证据的位置，不是工作项。`)
    push('')
    push('| # | 没做完的那件事 | 影响 | 关联检查点 | 补上要做的动作 |')
    push('|---:|---|---|---|---|')
    for (const [index, item] of shortfalls.entries()) {
      const impact = item.affects === 'direction' ? '**影响方向选择**' : '局部补充'
      const linked = item.cells.length === 0 ? '—' : item.cells.join('、')
      push(`| ${index + 1} | **${item.title}**${item.detail === '' ? '' : `<br>${item.detail}`} | ${impact} | ${linked} | ${item.nextAction === '' ? '—' : item.nextAction} |`)
    }
    push('')
    push('> 「补上要做的动作」是这件事本身要补什么，**不是**"补上能涨几分"。')
    push('')
  }

  // ── 十二格 ───────────────────────────────────────────
  push('### 十二格')
  push('')
  // ★ 0.7.3：去掉「证据线索」列。它印的是 0.3.x 的 A/B 维度命中
  //   （`A4` 模糊与夸大、`B1` 目的陈述…），在四层口径下既不是依据也不是线索 ——
  //   它属于另一套尺子，混进来只会让人以为四层分是从这些词表推出来的。
  //   四层的依据在下面「判定与证据」一节，逐格带引文与行号。
  push('| 格 | 检查点 | 分 | 状态 | 归属 | 判定 / 为什么没分 |')
  push('|---|---|---:|---|---|---|')
  for (const id of CELL_DISPLAY_ORDER) {
    const cell = layers.cells.find(item => item.id === id)
    const judgement = cell.state === 'rated'
      ? (cell.note === '' ? '—' : cell.note)
      : whyUnscored(cell)
    const stateLabel = cell.state === 'rated' ? '已评'
      : (cell.state === 'undetermined' ? '**待确认**' : (cell.state === 'not-applicable' ? '不适用' : '未评'))
    push(`| **${id}** | ${cell.label} | ${cell.state === 'rated' ? `**${cell.score}**` : '—'} | ${stateLabel} | ${cell.attribution === 'other-party' ? '他人/审批方' : (cell.attribution === 'submitter' ? '提交者' : '—')} | ${judgement} |`)
  }
  push('')
  push('**0–10 的含义**（按剩余工作程度判，不看字段数量）：')
  push('')
  for (const score of [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
    push(`- **${score}** ${SCORE_ANCHORS[score].label} —— ${SCORE_ANCHORS[score].test}`)
  }
  push('')
  push(`> 允许 .5 一档（共 ${SCORE_MAX * 2 + 1} 个可用值）。半档要能说出"比下一档多做到了什么"，说不出就退到整档。`)
  push('')
  push(`> ${SCORE_MAX} 分是「本阶段该做的做完了」，**不是**「方案无懈可击、结果一定达成」。`)
  push('')

  // ── 扣分闸 ───────────────────────────────────────────
  push('### 扣分闸：四条件同时成立')
  push('')
  push('一条缺口要算成扣分，必须四问全有答案，缺一条就只能列为建议：')
  push('')
  push('| 条件 | 要求 |')
  push('|---|---|')
  for (const id of ['C1', 'C2', 'C3', 'C4']) {
    push(`| **${id}** | ${CONDITIONS[id].label} —— ${CONDITIONS[id].test} |`)
  }
  push('')
  push('> 责任归属**只是其中一个条件**，不是开关。')
  push('> 「决定权不在提交者」也推不出「提交者没有准备信息的义务」——')
  push('> 拿货价由上级批，但推荐价、理由、与公司标准的关系，仍是提交者该准备的。')
  push('')
  if (layers.deductions.accepted.length > 0) {
    push(`**过闸的扣分 ${layers.deductions.accepted.length} 处**：${layers.deductions.accepted.map(item => `${item.cell}（${item.score} 分）`).join('、')}`)
    push('')
  }
  if (layers.deductions.downgraded.length > 0) {
    push(`**四条件不全 ${layers.deductions.downgraded.length} 处（应已在校验阶段退回重判，正常情况为 0）**：`)
    push('')
    for (const item of layers.deductions.downgraded) {
      push(`- **${item.cell}**（${item.score} 分）缺 ${item.missing.join('、')}：${item.reasons[0]}`)
    }
    push('')
  }
  // ★ 0.6.0 的 bug 就在这里：判据取 deductions.accepted/downgraded 是否为空，
  //   而机器分的格根本进不了这两个数组 —— 于是表里明明有 2 分，报告却印"没有低于 4 分的格"。
  //   判"有没有低于 4 分的格"要直接看格子，不要看闸的产物。
  const belowFour = ratedCells.filter(cell => typeof cell.score === 'number' && cell.score < GAP_AT)
  // ★ 0.7.13：删掉「每一处缺口值多少分」。那是**数学情景**：它假设"只补这一格、别的都不动"，
  //   现实里补预算的同时口径也就统一了。印出来只会把修订引向追分，而不是把活干完。
  if (ratedCells.length > 0 && belowFour.length === 0) {
    push(`本次没有低于 ${SCORE_MAX} 分的格，扣分闸无需判定。`)
    push('')
  }

  // ── 推进结论的依据（三段式）───────────────────────────
  //
  // ★ 0.7.0：把"能不能给整份交付下结论"和"现在能不能开工"分开。
  //   0.6.0 把两者绑死 —— 只要综合分不出，结论就只能写"无法判断"，
  //   于是附件没随文这种局部未知会把整份文件的有用建议一起吞掉。
  const advice = layers.advice ?? { canStartNow: [], mustDo: [], mustWait: [], conclusionReady: false, conclusionNote: '' }
  push('### 推进结论的依据')
  push('')
  push('**① 已有充分依据、可以推进**')
  push('')
  if (advice.canStartNow.length === 0) push('- （没有可确认的部分）')
  else for (const item of advice.canStartNow) push(`- ${item}`)
  push('')
  push('**② 需要补充或确认**')
  push('')
  if (advice.mustDo.length === 0 && advice.mustWait.length === 0) push('- （无需补充项）')
  else for (const item of advice.mustDo) push(`- ${item}`)
  if (advice.mustWait.length > 0) {
    for (const item of advice.mustWait) push(`- 等确认：${item}`)
  }
  push('')
  push('**③ 是否具备给整份交付下结论的依据**')
  push('')
  push(advice.conclusionReady === true
    ? '- **具备** —— 缺口都在局部，不影响"这份交付整体能不能用"的判断。'
    : `- **暂缓** —— ${advice.conclusionNote}`)
  push('')
  if (readiness.downgradedNote !== undefined) {
    push(`> ${readiness.downgradedNote}`)
    push('')
  }

  // ── 待确认 / 不适用 ──────────────────────────────────
  const pendingItems = layers.pendingItems ?? []
  if (pendingItems.length > 0 || pendingCells.length > 0) {
    push('### 待确认（不填 0 分，也不填满分）')
    push('')
    push('| # | 待确认什么 | 会不会挡住结论 |')
    push('|---:|---|---|')
    for (const [index, item] of pendingItems.entries()) {
      push(`| ${index + 1} | ${item.label}${item.work === '' ? '' : `（影响：${item.work}）`} | ${item.blocks ? '**会 → 相关结论暂缓**' : '不会 → 先做不受影响的部分'} |`)
    }
    for (const cell of pendingCells) {
      push(`| ${pendingItems.length + 1} | 格 ${cell.id} ${cell.label}：${cell.note === '' ? '现有证据不足以判定' : cell.note} | 待定向，暂不进分母 |`)
    }
    push('')
    push('> 未知**不能当低分，也不能当满分** —— 两种都是拿"我不知道"去填一个结论。')
    push('> 所以它们**不进算式**：综合分只由已评的格算出来，未定的格不补分也不扣分；')
    push('> 已经通过某一格扣过分的事项，不再重复挡分。')
    if (typeof composite.floor === 'number' && (composite.floorCells ?? []).length > 0) {
      push(`> 这样做分数只会偏高：${composite.floorCells.join('、')} 若评为 0 分，综合分会低到 **${composite.floor}**。`)
    }
    push('')
  }
  if (naCells.length > 0) {
    push('### 不适用')
    push('')
    for (const cell of naCells) push(`- **${cell.id}** ${cell.label}：${cell.note === '' ? '该检查点不适用于本文件' : cell.note}`)
    push('')
  }

  // ── 判定与证据（可抽检：分数·判定·引文·行号同一行）──────────
  //
  // ★ 这一节替代 0.6.0 的「分数从哪来」。
  //   旧版印的是"这一格的分是从哪个标量推出来的"—— 那等于告诉读者"你的判断被替换成了除法"。
  //   新版印的是"这一格判成几分、凭什么原文"—— 检验分数只需看一行。
  if (review.ok === true) {
    push('### 判定与证据')
    push('')
    push('> 每一格的分数、判定、引文原句、行号印在同一行 —— **抽检只需看这一行**。')
    push('> 引文在生成时已逐字回原文核对；对不上的没有一句列进来。')
    push('')
    push('| 格 | 分 | 判定 | 原文依据 |')
    push('|---|---:|---|---|')
    for (const id of CELL_DISPLAY_ORDER) {
      const cell = layers.cells.find(item => item.id === id)
      if (cell === undefined) continue
      const scoreText = cell.state === 'rated'
        ? `**${cell.score}**`
        : (cell.state === 'not-applicable' ? 'N/A' : '待确认')
      const evidence = Array.isArray(cell.evidence) && cell.evidence.length > 0
        ? cell.evidence
          .map(entry => `L${entry.line}「${entry.quote.length > 40 ? `${entry.quote.slice(0, 40)}…` : entry.quote}」`)
          .join('；')
        : (cell.state === 'rated' ? '（无）' : '—')
      // ★ 首列刻意不加粗：十二格表已经用 `| **V1** |` 的写法，
      //   这里再加粗会让"按行首取格号"的解析把同一格数两遍。
      push(`| ${id} | ${scoreText} | ${cell.note === '' ? '—' : cell.note} | ${evidence} |`)
    }
    push('')
    const basisLabel = review.basis === 'task'
      ? '原始任务原话'
      : (review.basis === 'self-stated' ? '文件自述目标' : '**没有原始任务** —— 只评文件自身，不判任务承接')
    push(`> 评价基准：${basisLabel}。${review.basisNote === '' ? '' : review.basisNote}`)
    push('')
  }

  // ── 判定未通过核对（已退回，需重判）────────────────────
  const reviewRejects = Array.isArray(review.rejects) ? review.rejects : []
  if (reviewRejects.length > 0) {
    push('### 判定未通过核对（已退回，需重判）')
    push('')
    push('> 依据不成立，分就没有来源：这些格**不是降分保留，而是撤销判定**。')
    push('> 也不自动补成满分 —— 没理由的低分和没理由的满分，是同一种撒谎。')
    push('')
    for (const item of reviewRejects) {
      const label = CELLS[item.cell]?.label ?? ''
      push(`- **${item.cell}**${label === '' ? '' : ` ${label}`}：${item.reason}`
        + `${item.claimedScore === null || item.claimedScore === undefined ? '' : `（原判 ${item.claimedScore} 分）`}`)
    }
    push('')
  }
  // ★ 0.7.6：只留**用户能据此行动**的提醒。
  //   no-docid（没带原文指纹）、no-coverage（没带分段记录）、front-loaded（引文集中在前部）、
  //   coverage-gap（分段有缺口）—— 这四条是插件内部自检，用户看到了也不知道做什么，
  //   属于"写给维护者的日志"，不进报告。
  const INTERNAL_WARNING_KINDS = new Set(['no-docid', 'no-coverage', 'front-loaded', 'coverage-gap'])
  const reviewWarnings = (Array.isArray(review.warnings) ? review.warnings : [])
    .filter(item => !INTERNAL_WARNING_KINDS.has(item.kind))
  if (reviewWarnings.length > 0) {
    push('### 需要你知道的几件事')
    push('')
    for (const item of reviewWarnings) {
      push(`- ${item.cell === undefined ? '' : `**${item.cell}**：`}${item.message}`)
    }
    push('')
  }

  // ★ 0.7.6：删掉「本次评审依据的协议」表。
  //   六条铁律是**给模型和维护者的施工规范**，用户看报告只需要结论与依据；
  //   把它印进正文只会让一份 10 行的结论撑成 30 行。

  // ── 怎么提交评审 ──────────────────────────────────────
  if (review.ok !== true) {
    push('### 怎么提交评审')
    push('')
    push('先 `slop_prepare` 拿 docId、结构图与判定规程；通读全文后按下面结构提交：')
    push('')
    push('```json')
    push('{')
    push('  "basis": "task | self-stated | none",')
    push('  "docId": "<prepare 返回的 docId>",')
    push('  "coverage": [{ "from": 1, "to": 30, "note": "价格与模式" }, { "from": 31, "to": 86 }],')
    push('  "understanding": {')
    push('    "claims": [{ "text": "作者提出了什么", "quote": [{ "quote": "原文片段", "line": 3 }] }],')
    push('    "done":   [{ "text": "完成了什么",   "quote": [{ "quote": "原文片段", "line": 21 }] }],')
    push('    "open":   [{ "text": "哪些条件未成立","quote": [{ "quote": "原文片段", "line": 32 }] }]')
    push('  },')
    push('  "cells": [')
    push('    { "id": "V1", "state": "rated", "score": 2, "claimBasis": "明示",')
    push('      "note": "表格写 10 台起即含返利，§3.1 又限定单批 ≥20 台适用",')
    push('      "evidence": [{ "quote": "建议 10 台起", "line": 21 }, { "quote": "批量分销返利（单批 ≥20 台适用）", "line": 32 }],')
    push('      "deduction": { "C1": "发布前必须定", "C2": "起草职责", "C3": "两处直接冲突", "C4": "分销商按表格主张返利" } },')
    push('    { "id": "S1", "state": "undetermined", "note": "三档是自选还是待定稿（不挡结论）" }')
    push('  ],')
    push('  "gaps":    [{ "cell": "E3", "affects": "local", "work": "返利结算口径" }],')
    push('  "pending": [{ "label": "上一版是否已对外发出", "blocks": false }]')
    push('}')
    push('```')
    push('')
    push('硬约束：`understanding` 为空 → 不出分（先述后判）；每格 `rated` 至少一条能在原文逐字找到的引文；')
    push('`score<10` 必须四条件齐全，否则该格**退回重判**；`docId` 不符 → 旧评审不能套用到新版本。')
    push('')
  }

  push(`> ${layers.weightsNote}`)
  push('')
  return out
}

export function renderAuditMarkdown(report) {
  const lines = []
  const push = (...rows) => lines.push(...rows)

  push(`# 文件体检报告 · ${report.filename}`, '')
  push(`> 「AI垃圾过滤 / Kill AI Slop」· 引擎 ${report.engineVersion} · 规则集 \`${report.ruleSetVersion}\``)
  push('> 本报告为**技术性文档体检**：判的是这份文件能不能用，不鉴定作者、不评人。')
  // ★ 0.7.5：印出判定由谁给出。「选的模型」和「实际用的模型」是否一致，
  //   光看界面是核不了的 —— 必须落在报告上。
  const reviewer = report.layers?.review?.model
  if (reviewer !== null && reviewer !== undefined) {
    const at = String(reviewer.at ?? '')
    push(`> 判定由 **${reviewer.provider ?? '?'} / ${reviewer.model ?? '?'}**${at === '' ? '' : ` 于 ${at}`} 给出；引文核对与算术在本机完成。`)
  }
  push('')

  // ★ 0.7.11：判定是在「委托方声明」这个前提下做的，前提必须印出来 ——
  //   不然读者不知道这份分是按"方案"的尺子量的，还是按"会议纪要"的尺子量的。
  //   这两项现在既进了判定（提示词），也进报告（可复核），两处同源。
  const declaredType = report.docType?.label ?? ''
  const declaredLevel = report.distillation?.levelLabel ?? ''
  if (declaredType !== '' || declaredLevel !== '') {
    const typePart = declaredType === ''
      ? ''
      : `文档类型 **${declaredType}**${report.docType?.inferred === true ? '（委托方选了自动判断，由全文推定）' : '（委托方指定）'}`
    const levelPart = declaredLevel === '' ? '' : `期望产出 **${declaredLevel}**`
    push(`> 本次声明：${[typePart, levelPart].filter(part => part !== '').join(' ｜ ')}`)
    push('')
  }

  // ═══════════ 〇、四层判分（0.5.x 口径，放在最前）═══════════
  //
  // ★ 为什么这一段在最前面：0.3.x 的 A 指数量的是**文本属性**，
  //   而 Slop 量的是「任务要求 − 实际交付」的差值 —— 两者不是同一个量纲。
  //   把只有文本属性的东西放首屏，工具就会对真正的问题给出反向答案。
  //   四层十二格回答的才是那个问题，所以它排第一。
  if (report.layers !== undefined) {
    push(...renderLayersMarkdown({ ...report.layers, legacySections: report.legacySections === true }))
  }

  if (report.consistency !== undefined && report.consistency.ok === false) {
    push('## ⛔ 本次结果不可信：模块版本不一致')
    push('')
    push(`规则集是给引擎 **${report.consistency.rulesEngine}** 构建的，当前引擎是 **${report.consistency.engine}**。`)
    push('')
    push('这通常是**热重载残留**：构建后只重新导入了改动过的文件，未改动的模块仍停在旧版本。')
    push('症状很阴：报告上的版本号是新的，实际算分的是旧规则，而且**全程不报错**。')
    push('')
    push('**处置：重启 DSH 后重跑。** 这一版的两个指数、严重度、证据都不可信，请勿引用。')
    push('')
  }

  // 0.3.x 口径的旧章节默认**不渲染**：它和四层分不是同一个量纲，
  // 同屏只会让读者拿一个反向刻度的数字去解释另一个。需要留档时显式传 legacySections: true。
  // ★ 两边都返回**数组**，由本函数统一 join —— 0.7.1 踩过：renderLegacySections
  //   沿用了原函数的 `return lines.join('\n')`（字符串），这里再 spread 就会把
  //   整段旧章节拆成单字，报告看起来只剩一堆「#、一、判、断」。测试一次抓出 25 条。
  if (report.legacySections === true) return [...lines, ...renderLegacySections(report)].join('\n')
  return lines.join('\n')
}

/**
 * 0.3.x 口径的旧章节：表达指数（A）／三指数判断／逐维观测／退出分母明细／五要素提炼／复现信息。
 *
 * ★ 0.7.1 起默认不输出。保留它是因为：①证据链还有用（哪些词表命中、哪些维度不适用）；
 *   ②老报告的复现需要同一套章节号。但它**不能和四层分同屏** ——
 *   一个"越高越差"、一个"越高越好"，并排出现必然被读反。
 */
export function renderLegacySections(report) {
  const lines = []
  const push = (...rows) => lines.push(...rows)

  // ═══════════ 一、判断（金字塔顶：先说这份交付怎么样）═══════════
  //
  // ★ 0.2.5 这里放的是「表达体检 11.3 / 100（干净）」—— 一个把人引向"没问题"的结论，
  //   而它量的根本不是 Slop：A 是**文本属性**，Slop 是**「任务要求 − 实际交付」的差值**。
  //   一份读起来专业、数字密、却不知道要批什么的文件，A 分照样很低。
  //   于是工具对真正的那个问题给出了**反向答案**。
  //   改法不是换措辞，是换**放在第一位的东西**：先放可观测要素的计数。
  const observable = report.observable ?? computeObservable(report.distillation, report.scores.indexA, report.ledger?.status ?? null, '')

  push('## 一、判断')
  push('')

  // 首行放**唯一可算的综合结论**：Slop 得分（越高越重）。
  // 它不是"任务承接判断"，所以下一行立刻给出三层拆解，边界再往下 ——
  // 读者第一眼要一个数，但也必须知道这个数量的是什么。
  //
  // ★ 0.5.0 实测踩到：同一份报告里，§〇 说「四层分数本次不出」，
  //   紧接着 §一 印「体检得分 81 / 100（很高）」—— 而新模型是**越高越好**。
  //   读者看到"81 / 很高"只会理解成好消息，实际它表示 slop 很重。
  //   两套方向相反的分数并排出现，且原句没写方向 —— 这是最坏的一种歧义。
  //   ⇒ 两行都补方向标注，并显式说明它不是四层质量分。
  const showLayer = value => (value === null || value === undefined ? '不适用' : value)
  const scoreLine = observable.slopScore === null
    ? '**体检得分：本次不出分**'
    : `**体检得分 ${observable.slopScore} / 100（${observable.band}；越高越差）**`
  const layerLine = `表达 ${showLayer(observable.layers[0].value)} · 执行 ${showLayer(observable.layers[1].value)}`
    + ` · 决策 ${showLayer(observable.layers[2].value)}（权重 20 / 40 / 40，初案未校准；越高越差`
    + ' —— 这是 0.3.x 三指数，**不是四层质量分**；四层见 §〇）'

  if (report.ledger?.status === 'ok') {
    const l = report.ledger.report
    push(`**交付承接 · ${l.verdict.band}${l.verdict.tentative ? '（暂定）' : ''}**`)
    push('')
    push(l.verdict.text)
    push('')
    push(`关键义务 ${l.ledger.critical} / ${l.ledger.total}：`
      + `已满足 ${l.ledger.byCoverage.met} · 部分 ${l.ledger.byCoverage.partial} · `
      + `应有而缺失 ${l.ledger.byCoverage.missing} · 冲突未解 ${l.ledger.byCoverage.conflicting}。`
      + '逐条台账见第九节。')
    push('')
    push(scoreLine)
    push('')
    push(layerLine)
    push('')
  } else {
    // 没有台账时，首行不再写「未判定」——那句是**边界**，不是结论。
    // 首行放唯一可算的综合结论：Slop 得分。边界紧随其后，不藏。
    push(scoreLine)
    push('')
    push(layerLine)
    push('')
  }
  if (observable.rows.length > 0) {
    // S4：每条线索有稳定 ID（L1/L2/…），统计与明细可以按 ID 对齐 ——
    // 上一版写「不要互相核对数目」是回避问题，不是解决它。
    push(`| ID | ${observable.rowsLabel} | 计数 | 位置 |`)
    push('|---|---|---:|---|')
    for (const row of observable.rows) push(`| ${row.id} | ${row.label} | ${row.count} | ${row.where} |`)
    push('')
  }
  push('> 这些是**计数，不是判定**：它证明"这份交付里拿不出"，不能证明"作者没做"。')
  push('>')
  push('> 另外，**动作清单由词表抽取**：可能混入非本项目的动作描述（第三方平台功能介绍、历史事件、'
    + '效果说明），也可能漏掉正文里的实施安排。表中"N / M"只描述**这组抽取结果**，'
    + '**不代表全文执行安排的完整状况**。')
  push('')

  if (observable.tier !== 'assessed') {
    push(`> **边界**：${observable.verdict} —— ${observable.reason}`)
    push('')
  }
  push(`**表达层面：${report.scores.indexA.value === null
    ? '本次未评估'
    : `${report.scores.indexA.value} / 100（${report.scores.indexA.verdict.band}）`}。** ${observable.expressionNote}`)
  push('')
  push(`**执行层面：${observable.executionGap === null ? '不适用' : `${observable.executionGap} / 100`}。** ${observable.executionNote}`)
  push('')
  push(`**决策层面：${observable.decisionGap === null ? '不适用' : `${observable.decisionGap} / 100`}。** ${observable.decisionNote}`)
  push('')

  // ═══════════ 二、最该追问的三件事 ═══════════
  //
  // 顺序**固定**，依据老板给的 Slop 定义：「产出的决策与可落地执行越少，越 Slop」
  //   ⇒ 先问执行，再问决策依据，最后问要你决定什么。
  // 每条措辞都是**按类别写死的模板**，不生成判断 ——
  //   否则这一步就把刚拆掉的那个爱撒谎的分数又请回来了。
  push(`## 二、${observable.asksLabel}`)
  push('')
  if (observable.tier !== 'assessed') {
    push('> 以下三个方向**由扫描结果指向，尚未确认为缺口** —— 它们是需要核实的地方，不是已经认定的问题。')
    push('')
  }
  if (observable.asks.length === 0) {
    push('无 —— 三项可观测要素都没有观察到缺口。')
    push('')
    push('> 这不等于文件可用，只等于这三项没看出问题。其余维度见第六节。')
  } else {
    observable.asks.forEach((item, index) => {
      push(`**${index + 1}. ${item.title}**`)
      push('')
      push(`- **要问**：${item.ask}`)
      if (item.where !== '') push(`- **位置**：${item.where}`)
      push(`- **现状**：${item.current}`)
      push(`- **为什么要紧**：${item.why}`)
      push(`- **补什么**：${item.fix}`)
      push(`- **怎样算补齐**：${item.done}`)
      push('')
    })
  }

  // ═══════════ 三、本次没判什么 ═══════════
  push('## 三、本次没判什么')
  push('')
  push('> 结论在前、边界紧随其后：读者需要先知道"这一屏之外还有多少没看"，再决定信到哪。')
  push('')
  push('> 工作空转**不折算成分数**：它要回答"任务有没有被接住"，需要原始任务作另一个操作数。'
    + '分数能表达"写得多空"，表达不了"哪一条没接住、缺到什么程度"。')
  push('')
  // ★ 第四态：已观测 —— 数出来了，但不据以下判，也不进任何分数。
  const observedDims = report.dimensions.filter(item => item.state === 'observed')
  if (observedDims.length > 0) {
    push(`ℹ️ **${observedDims.length} 项维度为「已观测」**：`
      + `${observedDims.map(item => `${item.id} ${item.label}`).join('、')}`
      + ' —— 数出来了，但不据以下判，也不计分。')
    push('')
  }
  const confidence = report.scores.confidence
  push(`**可信度：${confidence.level}** — ${confidence.reasons.join('；')}。`)
  push('')

  // ★ 诚实声明：本地规则判不了的维度，必须出现在**结论区**，而不是藏在第五节。
  //   读者不会翻到第五节才决定要不要信第一句。把"我没看"印成"没问题"是最危险的假阴性，
  //   而且它专挑最重要的两维发生（逻辑一致性 / 决策支持）。
  const unjudged = report.scores.excluded.filter(item => item.state === 'insufficient')
  if (unjudged.length > 0) {
    push(`⚠️ **本次有 ${unjudged.length} 项维度本地规则判不了**：`
      + `${unjudged.map(item => `${item.id} ${item.label}`).join('、')}。`)
    push('')
    push('它们已经退出分母（不计入分数），但**它们不是"没问题"，只是"没被检查"**。'
      + '要判这类维度，请用 `slop_obligation_audit`（交付承接台账）—— 由具备语义判断能力的一方给判定，'
      + '本插件负责逐条复核引文。')
    push('')
  }

  // ── 交付承接（案 A：这一节才是"这份文件能不能用"的答案）──
  if (report.ledger?.status === 'ok') {
    // 台账结论已在第一节「判断」给出。**这里不再重复一遍** ——
    // 同一段结论印两次，读者会以为有两件事；而且第一屏已经写了"逐条台账见第九节"。
    // 0.2.6 首跑实测：§一 与 §三 各印了一份，内容一字不差。
  } else if (report.ledger?.status === 'pending') {
    push('⚠️ **本次没有交付承接结论。** 已收到任务原话，但**没有收到义务表** —— '
      + '本插件不自己拆义务：从文档倒推出来的义务表本质是最佳实践清单，会把任务缺口洗成"已满足"。')
    push('')
  } else if (report.ledger?.status === 'error') {
    push(`⚠️ **台账未成立**（${report.ledger.error.code}）：${report.ledger.error.message}`)
    push('')
    push('> 台账不成立时**不给承接结论** —— 宁可不出，也不接受一条对不上原文的判断。')
    push('')
  } else {
    push('⚠️ **本次没有交付承接结论。** 没有提供原始任务 —— '
      + '而"有没有把任务接住"必须有任务作另一个操作数。本报告只做表达体检与结构检查。')
    push('')
  }

  if (report.scores.coverage.withheldTotal) {
    push(`⚠️ **本次不出总分。** 解析覆盖率 ${pct(report.scores.coverage.parse)} 低于阈值 ${pct(report.scores.coverage.minParseCoverage)}；以下只给局部结论。`)
    push('')
  } else if (report.scores.coverage.partial) {
    push(`⚠️ **部分结论。** 可评估维度权重占比仅 ${pct(report.scores.coverage.evaluation)}，分数只代表这些维度。`)
    push('')
  }

  // ── 文件概况 ──
  push('## 四、文件与解析')
  push('')
  push('| 项 | 值 |')
  push('|---|---|')
  push(`| 文件名 | ${report.filename} |`)
  push(`| 格式 | ${report.file.format}${report.file.label === report.file.format ? '' : `（${report.file.label}）`} |`)
  push(`| 大小 | ${(report.file.bytes / 1024).toFixed(1)} KB |`)
  push(`| 正文字符 | ${report.file.chars}${report.file.truncated ? '（已截断）' : ''} |`)
  push(`| 段落 / 句 | ${report.stats.paragraphs} / ${report.stats.sentences} |`)
  push(`| 数值 / 日期 | ${report.stats.numbers} / ${report.stats.dates} |`)
  push(`| 文档类型 | ${report.docType.label}${report.docType.inferred ? '（自动判断）' : ''} |`)
  push(`| 解析覆盖率 | ${pct(report.parse.coverage)}（${report.file.parseMode}） |`)
  push('')
  if (report.parse.warnings.length > 0) {
    push('**解析警告**')
    push('')
    for (const warning of report.parse.warnings) push(`- ${warning}`)
    push('')
  }

  // ── 表达指数（B 已退出指数体系）──
  // 这里**不印一行"工作空转 不出分"**：印出来读者仍然会去找它的分数。
  // 改成直接指路台账 —— 少一个空格不如少一个误导。
  push('## 五、表达指数（A）')
  push('')
  push('> **工作空转（B）不再出指数。** 它要回答"任务有没有被接住"，需要原始任务作另一个操作数；'
    + '单看一份文档算不出缺口。B 的正式载体是**交付承接台账** —— 需要任务原话与义务表才会生成。')
  push('')
  push('| 指数 | 得分 | 档位 | 覆盖权重 | 说明 |')
  push('|---|---:|---|---:|---|')
  for (const index of [report.scores.indexA]) {
    const value = index.withheld ? '不出分' : `${index.value} / 100`
    push(`| ${index.label}（${index.id}） | ${value} | ${index.verdict.band} | ${index.coveredWeight}/${index.totalWeight} | ${index.withheld ? index.withheldReason : index.verdict.text} |`)
  }
  push('')

  // ── 逐维证据 ──
  push('## 六、逐维观测')
  push('')
  push('| 维度 | 权重 | 状态 | 严重度 | 一句话 |')
  push('|---|---:|---|---:|---|')
  for (const dimension of report.dimensions) {
    // ★ B 维度一律显示「线索 · 不计分」，且**不印严重度等级**。
    //   0.2.5 这里印的是「B3 论据支撑 · 已评估 · 3 · 影响关键判断或执行」，
    //   而屏幕下方正写着「B1~B6 只作线索，不计分…规则层判不了论证是否成立」。
    //   **表格在打最重的等级，声明在说它不算数** —— 读者只记得 3。
    //   等级与"不计分"不能并存：等级是最响的那句话。
    const isClue = dimension.index === 'B'
    // ★ 先报**状态**，再说"计不计分"。
    //   0.2.7 把 B 一律压成「线索 · 不计分」，于是 B2/B3/B4 明明判不了（insufficient），
    //   在第三节被点名"本地规则判不了"、在第六节却写成"线索 · 不计分"——同一维度两套说法。
    //   状态的差别比"计不计分"重要：**判不了 ≠ 数出来了 ≠ 没问题**。
    const baseLabel = dimension.state === 'scored'
      ? '已评估'
      : (dimension.state === 'not-applicable'
        ? '不适用'
        : (dimension.state === 'observed' ? '已观测 · 不计分' : '未能评估'))
    const stateLabel = (isClue && dimension.state === 'scored') ? '线索 · 不计分' : baseLabel
    // 严重度只在"既在算分体系里、又真的判过"时才有意义。
    // ⚠️ 这个判断**不在本文件下**：由 score.mjs 的 summarize 算一次写成 `counts`，
    //    客户端读同一个字段。曾经 markdown 与客户端各写一份，结果一边印「—」一边印「3」。
    const severity = dimension.counts
      ? `${dimension.severity} · ${dimension.severityLabel}`
      : '—'
    push(`| ${dimension.id} ${dimension.label} | ${dimension.weight}% | ${stateLabel} | ${severity} | ${(dimension.summary ?? '').replace(/\|/gu, '/')} |`)
  }
  push('')
  push('> ⚠️ **零命中不等于干净** —— 也可能只是规则没覆盖到这个体裁或语种。'
    + '判"没问题"要有"查过什么"作依据，不能只看 0 条命中。')
  push('')
  push('> **B1~B6 只作线索，不计分**（B 已退出指数体系）。'
    + '它们能提示"这里可能有"，但不能判定"这里确实有问题" —— 尤其 B3（论据支撑）、'
    + 'B4（逻辑一致性）、B5（决策支持）：规则层判不了论证是否成立，'
    + '只能判"同一句里有没有出处标记"，而**补一句"根据上述调查"就能满足它，推论跨越照样存在**。'
    + '这三项要判定，走交付承接台账。')
  push('')

  // ── 执行 / 决策 的扣分依据 ──
  //
  // 表达（A）在上一张表里逐维可核；执行（C）与决策（D）不按维度拆，
  // 所以它们必须在这里**自己把账本摊开**，否则首页那两个数字在全文里找不到出处。
  // 与面板的「三层得分的扣分依据」读同一份 `observable.layerEvidence`。
  push('### 执行 / 决策 的扣分依据')
  push('')
  push('> 表达（A）由上一张表逐维给出；这两层不按维度拆，扣分项在此逐条列出。')
  push('')
  for (const layer of report.observable.layerEvidence ?? []) {
    const head = layer.value === null ? '不出分' : `${layer.value} / 100`
    push(`#### ${layer.label}（${layer.key}）· 权重 ${layer.weight}% · ${head}`)
    push('')
    push(layer.basis)
    push('')
    if (layer.items.length === 0) {
      push('本层没有扣分项。')
      push('')
      continue
    }
    push('| 行号 | 缺什么 | 原文片段 |')
    push('|---|---|---|')
    for (const item of layer.items) {
      const at = item.line === null || item.line === undefined ? '—' : `第 ${item.line} 行`
      push(`| ${at} | ${item.missing} | ${String(item.text).replace(/\|/gu, '/')} |`)
    }
    push('')
  }

  push('### 证据明细')
  push('')
  push('> A 维度的命中是**结论依据**；B 维度的命中是**线索明细**，其条目数与第一节的统计口径不同'
    + '（第一节按逐句抽取统计，此处按词表逐句命中），不要互相核对数目。')
  push('')
  const withHits = report.dimensions.filter(dimension => dimension.hits.length > 0)
  if (withHits.length === 0) {
    push('本次没有任何命中。')
    push('')
  } else {
    for (const dimension of withHits) {
      push(`#### ${dimension.id} ${dimension.label}`)
      push('')
      for (const hit of dimension.hits) {
        push(`- **[${hit.rule}] 第 ${hit.line} 行**：${hit.snippet.replace(/\n/gu, ' ')}`)
        push(`  - 为什么：${hit.why}`)
        push(`  - 怎么改：${hit.fix}`)
        if (hit.note !== undefined) push(`  - 检查范围：${hit.note}`)
      }
      if (dimension.note !== undefined) push(`- 补充：${dimension.note}`)
      push('')
    }
  }

  // ── 证据缺口说明 ──
  // ⚠️ dimension.note 原先只在"有命中"的分支里渲染，于是「A2 检出重复但无法映射回原文」
  //    「A4 有程度词但带数字已放过」这类**没有命中却有话要说**的维度，说明被整段吞掉 ——
  //    读者只看到一个分数与一句摘要，看不到它凭什么给/不给。这一段就是补这个洞。
  const notedOnly = report.dimensions.filter(dimension => dimension.hits.length === 0 && dimension.note !== undefined)
  if (notedOnly.length > 0) {
    push('#### 证据缺口与放过说明（本维无命中，但有话要说）')
    push('')
    for (const dimension of notedOnly) push(`- **${dimension.id} ${dimension.label}**：${dimension.note}`)
    push('')
  }

  // ── 排除项 ──
  push('## 七、退出分母的维度明细（附录）')
  push('')
  if (report.scores.excluded.length === 0) {
    push('无 —— 全部维度均已评估。')
  } else {
    push('| 维度 | 状态 | 理由 |')
    push('|---|---|---|')
    for (const item of report.scores.excluded) {
      const stateLabel = item.state === 'not-applicable'
        ? '不适用'
        : (item.state === 'insufficient' ? '未能评估' : '已观测 · 不计分')
      push(`| ${item.id} ${item.label} | ${stateLabel} | ${item.reason ?? '—'} |`)
    }
    push('')
    push('> 这三态**不得互相顶替**：不适用（这份文件不需要这一项）≠ 未能评估（我没法判）≠ 0 分（判过了，没问题）。')
  }
  push('')

  // ── 五要素 ──
  push('## 八、五要素提炼')
  push('')
  push(renderDistillMarkdown({
    level: report.distillation.level,
    levelLabel: report.distillation.levelLabel,
    levelDesc: '',
    method: report.distillation.method,
    elements: report.distillation.elements,
    evidenceAndLimits: report.distillation.evidenceAndLimits,
    questions: report.distillation.questions,
    fidelity: report.distillation.fidelity,
    compression: report.distillation.compression,
  }, { headingLevel: 3 }))

  // ── 交付承接台账（附录 · 但它是主结论的来源）──
  //
  // ★ 编号必须跟着**实际渲染的章节**走。
  //   实测：没有台账时这一节整块跳过，编号就从"八"直接跳到"十"，
  //   读者会以为漏了一整节 —— 而正文里根本没有第九节。
  //   字面量编号在"有条件渲染"面前一定会断，改成递增。
  const CN_ORDINAL = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
  let sectionIndex = 9
  if (report.ledger !== null && report.ledger !== undefined) {
    push(`## ${CN_ORDINAL[sectionIndex - 1]}、交付承接台账`)
    sectionIndex += 1
    push('')
    if (report.ledger.status === 'ok') {
      // 台账渲染器自带一级标题、且自带一/二/三编号；嵌进本报告时必须降一级，
      // 否则读者会看到「七、交付承接台账 → 一、交付判断 → 三、关键缺口」这种自打编号。
      const ledgerMarkdown = renderObligationMarkdown(report.ledger.report, { headingLevel: 3 })
        .replace(/^#{1,6}\s+交付承接台账\s*\n+/u, '')
      push(ledgerMarkdown)
    } else if (report.ledger.status === 'pending') {
      push(report.ledger.message)
      push('')
      push(`> 处置：${report.ledger.hint}`)
      push('')
      push('**本次任务原话**')
      push('')
      push(`> ${report.ledger.task.replace(/\n/gu, ' ')}`)
    } else if (report.ledger.status === 'error') {
      push(`- 错误码：\`${report.ledger.error.code}\``)
      push(`- 说明：${report.ledger.error.message}`)
      if (report.ledger.error.hint !== undefined) push(`- 处置：${report.ledger.error.hint}`)
      push('')
      push('> 台账不成立时**不给承接结论** —— 宁可不出，也不接受一条对不上原文的判断。')
      if (report.ledger.task !== '') {
        push('')
        push('**本次任务原话**')
        push('')
        push(`> ${report.ledger.task.replace(/\n/gu, ' ')}`)
      }
    }
    push('')
  }

  // ── 复现信息 ──
  push(`## ${CN_ORDINAL[sectionIndex - 1]}、复现信息`)
  push('')
  push('```json')
  push(JSON.stringify({
    engineVersion: report.engineVersion,
    ruleSetVersion: report.ruleSetVersion,
    params: report.params,
    elapsedMs: report.elapsedMs,
  }, null, 2))
  push('```')
  push('')
  push('> 规则集、权重、阈值任一变更都会换版本号；**新旧版本的分数不直接可比**。')
  push('> 权重与阈值当前为初案（未经校准），首个真实盲测后回写实测值。')
  push('')
  push('> 本报告由本地规则引擎自动生成，不构成对作者或文件的评价；是否采纳由使用者判断。')

  return lines
}

export { DOC_TYPES, RULESET_VERSION, inferDocType }
