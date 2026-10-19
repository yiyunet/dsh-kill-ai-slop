// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/audit.mjs
/**
 * 编排层 —— 解析 → 评分 → 提炼 → 出报告。
 *
 * 这一层是**唯一**把三段串起来的地方，因此也承担三件事：
 *   ① 输入门禁（大小 / 类型 / 空文件）
 *   ② 覆盖判定（解析不足就不给总分，且把"为什么不足"写进报告）
 *   ③ 报告可复现（规则集版本 + 引擎版本 + 参数快照都写进报告末尾）
 */

import { distill, renderDistillMarkdown } from './distill.mjs'
import { auditObligations, renderObligationMarkdown } from './obligations.mjs'
import { parseFile, ParseError } from './parse.mjs'
import { DOC_TYPES, RULESET_ENGINE, RULESET_VERSION, evaluateAll, inferDocType } from './rules.mjs'
import { computeScores, SEVERITY_LABEL } from './score.mjs'

/** 引擎版本 —— 与规则集版本分开：引擎改计算流程，规则集改判定内容。 */
export const ENGINE_VERSION = '0.3.6'

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
      dimension.summary = `动作 ${counted.actions} 条中 ${counted.noOwner} 条无责任人、${counted.noDue} 条无期限（口径见第一节）。`
    }
  }

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

  const noOwner = actions.filter(item => item.owner === '未说明')
  const noDue = actions.filter(item => item.due === '未说明')
  const badActions = actions.filter(item => item.owner === '未说明' || item.due === '未说明')
  const noSupport = claims.filter(item => item.support !== '同句有依据标记')

  const lineList = items => {
    const lines = [...new Set(items.map(item => item.line).filter(line => Number.isFinite(line)))]
    if (lines.length === 0) return '—'
    return lines.slice(0, 6).map(line => `第 ${line} 行`).join(' / ') + (lines.length > 6 ? ' …' : '')
  }

  const rows = []
  if (actions.length > 0) {
    rows.push({ id: 'L1', label: '动作项无责任人', count: `${noOwner.length} / ${actions.length}`, where: lineList(noOwner) })
    rows.push({ id: 'L2', label: '动作项无期限', count: `${noDue.length} / ${actions.length}`, where: lineList(noDue) })
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
    claims: claims.length,
    noOwner: noOwner.length,
    noDue: noDue.length,
    noSupport: noSupport.length,
    badActions: badActions.length,
    purposeMissing: PURPOSE_MISSING,
    noTradeoff: NO_TRADEOFF,
  }

  // 执行缺口：动作项里没写全的比例。没有动作项 → 不出分（不是 0 分）
  const executionGap = actions.length === 0
    ? null
    : Math.round((100 * badActions.length) / actions.length)

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
    ? '本次没有抽取到动作项，执行层面不适用。'
    : (badActions.length === actions.length
      ? `动作 ${counted.actions} 条里 ${counted.noOwner} 条缺责任人、${counted.noDue} 条缺期限 —— 抽出来的动作没有一条写全。`
      : `动作 ${counted.actions} 条里 ${counted.noOwner} 条缺责任人、${counted.noDue} 条缺期限。`)

  const decisionNote = `主张 ${counted.claims} 条里 ${counted.noSupport} 条同句没有依据标记`
    + (PURPOSE_MISSING ? '；全文没有明示目的，读完不知道该批什么' : '')
    + (NO_TRADEOFF ? '；也没有任何取舍表述，只列了选项没做选择' : '')
    + '。'

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
      title: `动作项 ${actions.length} 条：${noOwner.length} 条无责任人 · ${noDue.length} 条无期限`,
      ask: '首个必要动作，谁在什么时候做到什么程度？',
      where: lineList(badActions),
      why: '缺这一层，方案停在纸上：接收者要么自己派活，要么重新开一次会 —— 这正是"把执行转嫁给接收者"。',
      // ★ 补齐标准不是"字段填满"。补个姓名和日期，错误前提与模糊动作照样在。
      fix: '首个必要动作补齐五项：明确对象、责任人、时间安排、交付物、启动条件。',
      done: '拿到这条安排就能直接开工 —— 不用再问"找谁、什么时候、算做到什么程度"。',
      // S5：补齐标准要成为**判定**，不能只写在"怎么补"里。
      // 判据就是这条 ask 自己的口径：有动作项且全部缺 → 未达到；部分缺 → 部分达到。
      current: badActions.length === actions.length ? '未达到' : '部分达到',
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
  }
}

/** 渲染完整 Markdown 报告。 */
export function renderAuditMarkdown(report) {
  const lines = []
  const push = (...rows) => lines.push(...rows)

  push(`# 文件体检报告 · ${report.filename}`, '')
  push(`> 「AI垃圾过滤 / Kill AI Slop」· 引擎 ${report.engineVersion} · 规则集 \`${report.ruleSetVersion}\``)
  push('> 本报告为**技术性文档体检**：判的是这份文件能不能用，不鉴定作者、不评人。')
  push('')
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
  const showLayer = value => (value === null || value === undefined ? '不适用' : value)
  const scoreLine = observable.slopScore === null
    ? '**体检得分：本次不出分**'
    : `**体检得分 ${observable.slopScore} / 100（${observable.band}）**`
  const layerLine = `表达 ${showLayer(observable.layers[0].value)} · 执行 ${showLayer(observable.layers[1].value)}`
    + ` · 决策 ${showLayer(observable.layers[2].value)}（权重 20 / 40 / 40，初案未校准；越高越重）`

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
  push(`| 格式 | ${report.file.format}（${report.file.label}） |`)
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
    // 严重度只在"既在算分体系里、又真的判过"时才有意义。B 一律不印。
    const severity = (isClue || dimension.state !== 'scored')
      ? '—'
      : `${dimension.severity} · ${dimension.severityLabel}`
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
  if (report.ledger !== null && report.ledger !== undefined) {
    push('## 九、交付承接台账')
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
  push('## 十、复现信息')
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

  return lines.join('\n')
}

export { DOC_TYPES, RULESET_VERSION, inferDocType }
