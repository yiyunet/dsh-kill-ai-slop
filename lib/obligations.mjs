// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/obligations.mjs
/**
 * 义务台账 —— 案 A 的分层契约里最关键的一层。
 *
 * ┌─ 设计命题 ────────────────────────────────────────────────────────────┐
 * │ 用**确定的规则**，去审计**不确定的语义**。                              │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 背景（为什么不再直接算一个 B 分数）：
 *   Work Slop 的定义是"任务要求 与 实际交付 之间的缺口"。这是一个**两个操作数的差**。
 *   只用一份文档去算它，无论规则写得多细，测的都是"文章写得好不好"，不是"任务有没有被接住"。
 *   所以 B 不再是一个 0–100 的指数，而是一本**台账**：义务逐条记账，缺口逐条列名。
 *
 * 分工（这是本文件存在的全部理由）：
 *   L2 语义层 —— 由具备语义判断能力的一方（宿主 agent / 模型）完成：
 *                拆义务、判覆盖、找证据、写缺口与解除标准。
 *   L3 校验层 —— **本文件**，纯规则、零依赖、完全确定：
 *                ① 每条引文是否真的存在于原文，行号对不对；
 *                ② 状态是否自洽（说"已满足"却拿不出证据 = 违规）；
 *                ③ 结论是否越权（无任务基准时不许说"满足交付要求"）；
 *                ④ 同一根因是否被拆成多条重复处罚；
 *                ⑤ 把结果汇总成台账与首页六段。
 *
 *   模型最容易骗人的地方，正是**编行号和编引文** —— 而规则层在这件事上 100% 可靠。
 *   这就是为什么 L3 不是辅助，而是命门。
 *
 * 一条硬规矩：
 *   引文 VERIFIED 只说明"原文确实这么写"，**不说明这句话是真的、也不说明它是好方案**。
 *   本模块从不判断对错，只判断"有没有"。
 */

/** 义务覆盖状态。四值，互不顶替。 */
export const COVERAGE_VALUES = ['met', 'partial', 'missing', 'conflicting']
/** 义务来源。三档，防止把评审者临时想到的最佳实践全变成扣分项。 */
export const ORIGIN_VALUES = ['explicit', 'essential', 'optional']
/** 评审基准。三档降级：有任务原话 → 按自述目标 → 无基准。 */
export const BASIS_VALUES = ['task', 'self-stated', 'none']

export const OBLIGATION_SCHEMA_VERSION = '2.0'

/**
 * 引文最短长度。
 *
 * v2 方案提到过一个真实教训：不能凭 "P2" 两个字符去判断"指的是同一个对象"。
 * 两个字符在任何长文里都能找到几处，校验等于没校验。四字（或四个非空字符）起才具备锚定力。
 */
const MIN_QUOTE_CHARS = 4

const COVERAGE_LABEL = {
  met: '已满足',
  partial: '部分满足',
  missing: '应有而缺失',
  conflicting: '冲突未解',
}
const ORIGIN_LABEL = {
  explicit: '任务明确要求',
  essential: '完成该任务不可缺少',
  optional: '可选优化项',
}

class ObligationError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.code = code
    this.hint = hint
    this.stage = 'obligation'
  }
}

/* ──────────────────────── ① 引文复核（命门） ──────────────────────── */

/** 把原文切成行，返回每行起始偏移，用于 offset → line 映射。 */
function lineIndex(docText) {
  const starts = [0]
  for (let at = 0; at < docText.length; at += 1) {
    if (docText[at] === '\n') starts.push(at + 1)
  }
  return starts
}

function lineOfOffset(starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

/**
 * 引文复核 —— 本模块唯一真正"确定"的能力。
 *
 * @returns {{ok: boolean, reason?: string, line?: number, occurrences?: number[], hint?: string}}
 */
export function verifyQuote(docText, quote, claimedLine) {
  const needle = String(quote ?? '').trim()
  if (needle === '') return { ok: false, reason: '引文为空' }

  const charCount = [...needle].filter(char => !/\s/u.test(char)).length
  if (charCount < MIN_QUOTE_CHARS) {
    return {
      ok: false,
      reason: `引文太短（${charCount} 个有效字符，至少需 ${MIN_QUOTE_CHARS} 个）—— 短到能在原文里随机命中，校验等于没校验`,
      hint: '请引用一段能唯一锚定的完整短语，不要用编号或代号（如 "P2"）单独充当证据。',
    }
  }

  const occurrences = []
  let from = 0
  for (;;) {
    const at = docText.indexOf(needle, from)
    if (at < 0) break
    occurrences.push(at)
    from = at + needle.length
    if (occurrences.length > 50) break
  }

  if (occurrences.length === 0) {
    return { ok: false, reason: '原文中找不到这段引文（逐字比对，含标点与空格）' }
  }

  const starts = lineIndex(docText)
  const lines = occurrences.map(offset => lineOfOffset(starts, offset))

  if (claimedLine === undefined || claimedLine === null) {
    return { ok: true, line: lines[0], occurrences: lines }
  }

  const claimed = Number(claimedLine)
  if (!Number.isFinite(claimed)) return { ok: false, reason: 'line 不是数字' }
  if (lines.includes(claimed)) return { ok: true, line: claimed, occurrences: lines }
  return {
    ok: false,
    reason: `引文确实存在，但不在第 ${claimed} 行`,
    line: lines[0],
    occurrences: lines,
    hint: `它在第 ${lines.join('、')} 行 —— 请核对行号。行号错了，读者会去错的地方核对，整份报告的信任就没了。`,
  }
}

/* ──────────────────────── ② 输入归一化 ──────────────────────── */

const pick = (object, ...keys) => {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) return object[key]
  }
  return undefined
}

/**
 * 归一化一条义务。同时接受 camelCase 与 snake_case —— 模型两种都会写，
 * 因为命名差异就整份拒收，是把校验器的洁癖变成使用者的成本。
 */
function normalizeObligation(raw, index) {
  const violations = []
  const id = String(pick(raw, 'id', 'obligationId', 'obligation_id') ?? `O${index + 1}`).trim()

  const question = String(pick(raw, 'question', 'requirement', 'ask', 'title') ?? '').trim()
  if (question === '') violations.push({ id, field: 'question', reason: '缺少"这条义务要回答什么问题"' })

  const origin = String(pick(raw, 'origin', 'source', 'originType', 'origin_type') ?? 'essential').trim()
  if (!ORIGIN_VALUES.includes(origin)) {
    violations.push({ id, field: 'origin', reason: `origin 必须是 ${ORIGIN_VALUES.join(' / ')}，收到「${origin}」` })
  }

  const coverageRaw = String(pick(raw, 'coverage', 'coverageStatus', 'coverage_status', 'status') ?? '').trim()
  const coverage = COVERAGE_VALUES.includes(coverageRaw) ? coverageRaw : null
  if (coverage === null) {
    violations.push({
      id,
      field: 'coverage',
      reason: `coverage 必须是 ${COVERAGE_VALUES.join(' / ')}，收到「${coverageRaw || '空'}」。`
        + '不许用"没问题""通过"这类非枚举值 —— 状态必须可机器统计。',
    })
  }

  const criticalRaw = pick(raw, 'critical', 'isCritical', 'is_critical')
  const critical = criticalRaw === undefined ? origin !== 'optional' : criticalRaw === true || criticalRaw === 'true'

  const evidenceRaw = pick(raw, 'evidence', 'quotes', 'evidenceIds') ?? []
  const evidence = Array.isArray(evidenceRaw) ? evidenceRaw : []
  if (!Array.isArray(evidenceRaw)) violations.push({ id, field: 'evidence', reason: 'evidence 必须是数组' })

  return {
    id,
    question,
    origin,
    originLabel: ORIGIN_LABEL[origin] ?? origin,
    originReason: String(pick(raw, 'originReason', 'origin_reason') ?? '').trim(),
    critical,
    coverage,
    coverageLabel: coverage === null ? '状态不合法' : COVERAGE_LABEL[coverage],
    finding: String(pick(raw, 'finding', 'verdict', 'note') ?? '').trim(),
    impact: String(pick(raw, 'impact', 'consequence') ?? '').trim(),
    repair: String(pick(raw, 'repair', 'todo', 'action') ?? '').trim(),
    resolutionTest: String(pick(raw, 'resolutionTest', 'resolution_test', 'doneWhen', 'done_when') ?? '').trim(),
    evidence: evidence.map((item, at) => ({
      id: String(pick(item, 'id') ?? `${id}-E${at + 1}`),
      quote: String(pick(item, 'quote', 'text', 'excerpt') ?? ''),
      line: pick(item, 'line', 'lineNo', 'line_no'),
    })),
    violations,
  }
}

/* ──────────────────────── ③ 校验与汇总 ──────────────────────── */

function evaluateObligation(obligation, docText) {
  const violations = [...obligation.violations]
  const evidence = obligation.evidence.map(item => {
    const check = verifyQuote(docText, item.quote, item.line)
    return {
      ...item,
      verified: check.ok,
      reason: check.reason,
      actualLine: check.line,
      hint: check.hint,
    }
  })

  const verifiedCount = evidence.filter(item => item.verified).length
  const brokenEvidence = evidence.filter(item => !item.verified)

  // 状态自洽：说"已满足 / 部分满足"却拿不出一条能对上的引文 —— 这是最典型的模型幻觉形态。
  // 注意这里不判对错，只判"有没有"：引文对上只说明原文这么写，不说明判断成立。
  if ((obligation.coverage === 'met' || obligation.coverage === 'partial') && verifiedCount === 0) {
    violations.push({
      id: obligation.id,
      field: 'evidence',
      reason: `coverage 标为「${obligation.coverageLabel}」，但没有任何一条引文通过复核 —— `
        + (evidence.length === 0 ? '根本没提供证据。' : '提供的引文全部对不上原文。'),
    })
  }

  // 冲突必须有两处：只说"有冲突"却只给一条证据，读者无从核对冲突的另一半。
  if (obligation.coverage === 'conflicting' && verifiedCount < 2) {
    violations.push({
      id: obligation.id,
      field: 'evidence',
      reason: `coverage 标为「冲突未解」，但通过复核的引文只有 ${verifiedCount} 条 —— 冲突至少要能指到互相矛盾的两处。`,
    })
  }

  if (obligation.coverage === 'missing' && evidence.length > 0) {
    // 允许，但要写清：missing 配证据，通常意味着"用某段文字反证它没给答案"，必须说明指向什么。
    if (obligation.finding === '') {
      violations.push({
        id: obligation.id,
        field: 'finding',
        reason: 'coverage 标为「应有而缺失」却附了引文，必须用 finding 说明这条引文指向哪个缺口。',
      })
    }
  }

  const status = brokenEvidence.length === 0 ? 'confirmed' : 'degraded'
  return {
    ...obligation,
    evidence,
    verifiedCount,
    brokenEvidence,
    violations,
    // degraded = 有引文没对上；此时该义务的判定**不可采信**，台账里必须显式标出来
    status,
    adoptable: status === 'confirmed' && obligation.coverage !== null,
  }
}

/** 同根因去重：问题描述过度相似的两条义务会重复处罚同一处缺陷。 */
function findDuplicates(obligations) {
  const pairs = []
  const normalized = obligations.map(item => ({
    id: item.id,
    text: `${item.question} ${item.finding}`.replace(/\s/gu, ''),
  }))
  // 太短的描述互相包含没有意义（"渠道"包含于"渠道选择"），只会制造噪音
  const MIN_COMPARE = 12
  for (let a = 0; a < normalized.length; a += 1) {
    for (let b = a + 1; b < normalized.length; b += 1) {
      const left = normalized[a]
      const right = normalized[b]
      if (left.text.length < MIN_COMPARE || right.text.length < MIN_COMPARE) continue
      if (left.text === right.text || left.text.includes(right.text) || right.text.includes(left.text)) {
        pairs.push({ a: left.id, b: right.id, reason: '问题描述高度重合，可能在对同一处缺陷重复处罚' })
      }
    }
  }
  return pairs
}

/** 结论闸门。这一段决定"能不能说满足"，是全模块唯一敢下结论的地方。 */
function verdictOf({ basisKind, obligations, blocking, open, degraded, violations, criticalViolations }) {
  const criticalCount = obligations.filter(item => item.critical).length
  const degradedCritical = degraded.filter(item => item.critical).length

  // 关键义务的引文对不上、或状态不是合法枚举 —— 下结论无从谈起。
  if (criticalViolations.length > 0) {
    return {
      band: '不予判定',
      tentative: true,
      reason: `评审输出有 ${criticalViolations.length} 处关键不合契约（见「校验不通过」），本台账不出结论。`,
      text: '关键义务的判断没通过本地校验，不能作为验收依据。补齐后重跑。',
    }
  }

  if (basisKind === 'none') {
    return {
      band: '无基准，不判定任务承接',
      tentative: true,
      reason: '没有任务原话，也没有文档自述目标 —— 义务清单只能来自通用最佳实践，而那不是"任务要求"。',
      text: '本次只列清单，不判断"任务是否被接住"。要得到交付判断，请补一行任务原话后重跑。',
    }
  }

  if (degradedCritical > 0) {
    return {
      band: '暂定',
      tentative: true,
      reason: `有 ${degradedCritical} 条关键义务所依据的引文没通过复核，它们的判定不可采信。`,
      text: '结论暂定：请先核对引文，再重跑。引文对不上的判断，等同于没有判断。',
    }
  }

  if (blocking.length > 0) {
    return {
      band: '关键缺口：需返工',
      tentative: violations.length > 0,
      reason: `${blocking.length} / ${criticalCount} 条关键义务未承接（缺失或冲突未解）。`,
      text: `接收者仍要亲自补 ${blocking.length} 件事才能推进；这不是润色能解决的。`,
    }
  }

  if (open.length > 0) {
    return {
      band: basisKind === 'task' ? '部分满足：需补齐列明事项' : '按自述目标：部分满足，需补齐列明事项',
      tentative: basisKind !== 'task' || violations.length > 0,
      reason: `${open.length} 条关键义务只做到部分覆盖。`,
      text: '主体可推进，但要按「补齐要求」逐条收口，否则执行到一半会卡住。',
    }
  }

  // ★ 结论行必须与**基准强度**一致。
  //   「满足本次交付要求」这句话里其实藏了两个断言：
  //     ① 义务都承接了 —— 已验；
  //     ② 这些义务就是"本次交付要求" —— 只有拿到任务原话才成立。
  //   没有任务时 ② 从未被验立：自述目标是作者自己说的，可能低于委托方的要求。
  //   过去靠正文补一句免责糊过去，但**读者只读 band**，免责救不回来。
  if (basisKind !== 'task') {
    return {
      band: '按自述目标：已满足（未对真实任务判定）',
      tentative: false,
      reason: `${criticalCount} 条关键义务都有可核对证据，但基准是文档自述目标，不是任务原话。`,
      text: '按文档自己声称要解决的问题衡量，义务都承接了。'
        + '这**不等于**满足真实任务要求 —— 自述目标可能低于委托方的要求。'
        + '要下任务承接结论，请补一行任务原话后重跑。',
    }
  }

  return {
    band: '满足本次交付要求',
    tentative: violations.length > 0,
    reason: `${criticalCount} 条关键义务全部有可核对证据支撑。`,
    text: '可以围绕已提出的具体选择作出批准或调整，并让对方立即推进。',
  }
}

/* ──────────────────────── ④ 主入口 ──────────────────────── */

/**
 * 对一份「义务表 + 原文」做校验与汇总。
 *
 * @param {{docText: string, task?: string, basis?: string,
 *          obligations: object[], sourceMode?: string}} input
 */
export function auditObligations(input) {
  const docText = String(input.docText ?? '')
  if (docText.trim() === '') {
    throw new ObligationError('NO_TEXT', '没有原文可核对 —— 引文复核需要原文全文。',
      '同时传入 text（原文）或 path（文件路径）。拿不到原文，本工具就无法承担"复核"这件事。')
  }

  const rawObligations = input.obligations
  if (!Array.isArray(rawObligations) || rawObligations.length === 0) {
    throw new ObligationError('NO_OBLIGATIONS', 'obligations 必须是非空数组。',
      '先由语义层（模型）给出义务清单，再交本工具校验。本工具不替模型编义务。')
  }

  const taskText = String(input.task ?? '').trim()
  const basisRequested = String(input.basis ?? '').trim()
  const basisKind = BASIS_VALUES.includes(basisRequested)
    ? basisRequested
    : (taskText === '' ? 'none' : 'task')

  if (basisKind === 'task' && taskText === '') {
    throw new ObligationError('TASK_REQUIRED', '基准设为「按原始任务评估」，但没有给出任务原话。',
      '没有任务原话就没有基准，"任务承接"无从谈起。要么补上任务原文，要么把 basis 设为 none。')
  }

  const normalized = rawObligations.map((raw, index) => normalizeObligation(raw, index))
  const ids = new Set()
  const violations = []
  for (const item of normalized) {
    if (ids.has(item.id)) violations.push({ id: item.id, field: 'id', reason: '义务 ID 重复' })
    ids.add(item.id)
    // 注意：normalize 阶段的违规由下面 evaluated 的循环统一收口 —— 两处都 push 会让同一条违规数两遍。
    if (item.origin === 'optional' && item.critical) {
      violations.push({
        id: item.id,
        field: 'critical',
        reason: '标为「可选优化项」却又标成关键义务 —— 可选项不能单独造成"不满足"的结论。',
      })
    }
  }

  const evaluated = normalized.map(item => evaluateObligation(item, docText))
  for (const item of evaluated) violations.push(...item.violations)

  // 分两类：能让结论作废的，和只让结论降级的。
  // 判据：关键义务的引文对不上，或状态本身不是合法枚举 —— 这两种下结论无从谈起。
  const criticalIds = new Set(evaluated.filter(item => item.critical).map(item => item.id))
  const criticalViolations = violations.filter(item => item.field === 'coverage' || criticalIds.has(item.id))

  const blocking = evaluated.filter(item => item.critical
    && (item.coverage === 'missing' || item.coverage === 'conflicting'))
  const open = evaluated.filter(item => item.critical && item.coverage === 'partial')
  const degraded = evaluated.filter(item => item.status === 'degraded')

  const verdict = verdictOf({
    basisKind,
    obligations: evaluated,
    blocking,
    open,
    degraded,
    violations,
    criticalViolations,
  })

  const ledger = {
    total: evaluated.length,
    critical: evaluated.filter(item => item.critical).length,
    byCoverage: COVERAGE_VALUES.reduce((acc, key) => {
      acc[key] = evaluated.filter(item => item.coverage === key).length
      return acc
    }, {}),
    invalid: evaluated.filter(item => item.coverage === null).length,
    blocking: blocking.map(item => item.id),
    open: open.map(item => item.id),
    satisfied: evaluated.filter(item => item.coverage === 'met').map(item => item.id),
    degraded: degraded.map(item => item.id),
    baseline: basisKind,
  }

  const report = {
    ok: true,
    schemaVersion: OBLIGATION_SCHEMA_VERSION,
    basis: {
      kind: basisKind,
      label: basisKind === 'task' ? '按原始任务评估' : (basisKind === 'self-stated' ? '按文档自述目标评估' : '无基准'),
      task: taskText,
      note: basisKind === 'task'
        ? '基准 = 任务原话。这是唯一能得出"任务承接"结论的基准。'
        : (basisKind === 'self-stated'
          ? '基准 = 文档自己声称要解决的问题。它可能低于真实任务要求，结论强度相应降低。'
          : '无基准：义务来自通用清单，只能当检查表用，不能当交付判定。'),
    },
    sourceMode: input.sourceMode ?? 'raw-text',
    obligations: evaluated,
    ledger,
    verdict,
    violations,
    duplicates: findDuplicates(evaluated),
    // 本模块的能力边界，写在数据里，避免下游误用
    notEvaluated: [
      '判断本身对不对（本工具只核对"引文存不存在"，不核对"结论成不成立"）',
      '外部事实的真实性（市场数据、渠道政策、合作关系，一律未核验）',
      '表达质量（套话、重复、结构 —— 那是 A 指数的事）',
    ],
    disclaimer: '本台账只核对证据是否可核，不判断方案好坏；判文件不判人，不用作员工评价。',
  }

  report.markdown = renderObligationMarkdown(report)
  return report
}

/* ──────────────────────── ⑤ 渲染 ──────────────────────── */

/**
 * 渲染台账 Markdown。
 *
 * `headingLevel` 默认 2（本模块自己写成一份独立文书）。
 * 嵌进体检报告时必须传 3 —— 否则台账自带的一、二、三 会接在报告的"七、"后面，
 * 读者看到的是「七、交付承接台账 → 一、交付判断 → 三、关键缺口 → 六、本次未评估什么」，
 * 编号顺序自己打自己。文字没错，结构错了，读者会以为中间漏了四、五。
 */
export function renderObligationMarkdown(report, options = {}) {
  const lines = []
  const push = (...rows) => lines.push(...rows)
  const { basis, ledger, verdict } = report

  // ══════════ 金字塔：结论 → 阻断项（各带证据）→ 次要件 → 边界 ══════════
  //
  // 一份检测 Slop 的报告，最容易自己变成 Slop。之前它就是这么变的：
  //   · 结论之前先读两行免责（规则集 schema、判什么不判什么）；
  //   · 「已承接的部分」整节写着"无"，白占一屏；
  //   · 台账内部一/二/三 + 外层报告一/二/…/九，两套编号；
  //   · 每条缺口最要紧的「要补什么」排在第四行，前面是"状态""来源"。
  //
  // 现在按「读者第一眼要知道什么」排：结论 → 阻断项（问题/影响/补什么/怎样算补齐/原文）
  // → 次要件 → 边界。元信息一律下沉文末。章节不再编号，用 O1/O2 作唯一标识 ——
  // 编号是排版，不是信息；嵌进别的文书时它只会制造冲突。
  push('# 交付承接台账', '')
  push(`**${verdict.band}${verdict.tentative ? '（暂定）' : ''}**`)
  push('')
  push(verdict.text)
  push('')

  const counts = [`${ledger.critical} 条关键义务`]
  counts.push(`${ledger.byCoverage.met} 已满足`)
  counts.push(`${ledger.byCoverage.partial} 只做到一部分`)
  counts.push(`${ledger.byCoverage.missing} 应有而缺失`)
  counts.push(`${ledger.byCoverage.conflicting} 冲突未解`)
  if (ledger.invalid > 0) counts.push(`${ledger.invalid} 条状态不合法`)
  if (ledger.degraded.length > 0) counts.push(`${ledger.degraded.length} 条引文未通过对复核`)
  push(`${counts.join(' · ')}。`)
  push('')

  if (basis.kind === 'task') {
    push(`> 基准：按原始任务评估 —— ${basis.task}`)
  } else {
    push(`> 基准：${basis.label} —— ${basis.note}`)
  }
  push('')

  const blocking = report.obligations.filter(item => item.critical
    && (item.coverage === 'missing' || item.coverage === 'conflicting'))
  const partials = report.obligations.filter(item => item.critical && item.coverage === 'partial')
  const met = report.obligations.filter(item => item.coverage === 'met' && item.status === 'confirmed')

  // ── 阻断项：一条一节 ──
  for (const item of blocking) {
    push(`## ${item.id} ${item.question}`)
    push('')
    push(`${item.coverageLabel} · 来源：${item.originLabel}${item.originReason === '' ? '' : ` —— ${item.originReason}`}`)
    push('')
    if (item.finding !== '') { push(`**问题**　${item.finding}`); push('') }
    if (item.impact !== '') { push(`**影响**　${item.impact}`); push('') }
    if (item.repair !== '') { push(`**要补什么**　${item.repair}`); push('') }
    if (item.resolutionTest !== '') { push(`**怎样算补齐**　${item.resolutionTest}`); push('') }

    const verified = item.evidence.filter(evidence => evidence.verified)
    const broken = item.evidence.filter(evidence => !evidence.verified)
    if (verified.length > 0) {
      push('**原文**')
      push('')
      for (const evidence of verified) {
        push(`> 第 ${evidence.actualLine} 行：${evidence.quote.replace(/\n/gu, ' ')}`)
      }
      push('')
    }
    if (broken.length > 0) {
      push('**引文未通过复核**')
      push('')
      for (const evidence of broken) {
        push(`> ⚠️ ${evidence.reason}`)
        if (evidence.hint !== undefined) push(`> ${evidence.hint}`)
      }
      push('')
    }
  }

  // ── 次要件：压成清单，不再一人一节 ──
  if (partials.length > 0) {
    push(`## 只做到一部分的 ${partials.length} 条`)
    push('')
    for (const item of partials) {
      const where = item.evidence.filter(e => e.verified).map(e => `第 ${e.actualLine} 行`).join(' / ')
      const ask = item.repair === '' ? item.coverageLabel : item.repair
      push(`- **${item.id} ${item.question}** ${ask}${where === '' ? '' : `（${where}）`}`)
    }
    push('')
  }

  // ── 已承接：有才成节，没有就一句话 ──
  if (met.length > 0) {
    push('## 已承接')
    push('')
    for (const item of met) {
      push(`- **${item.id} ${item.question}**`)
      if (item.finding !== '') push(`  - 判断：${item.finding}`)
      for (const evidence of item.evidence.filter(e => e.verified)) {
        push(`  - 第 ${evidence.actualLine} 行：${evidence.quote.replace(/\n/gu, ' ')}`)
      }
    }
    push('')
  } else if (blocking.length > 0 || partials.length > 0) {
    push(`> 已承接：无 —— ${ledger.critical} 条关键义务里，没有任何一条以「有可核对证据」的方式被满足。`)
    push('')
  }

  // ── 校验不通过 / 重复处罚（条件输出，不带序号）──
  if (report.violations.length > 0) {
    push('## 校验不通过')
    push('')
    push('> 这一节比结论重要：**宁可不出结论，也不接受一条对不上原文的判断。**')
    push('')
    for (const item of report.violations) {
      push(`- **${item.id} · ${item.field}**：${item.reason}`)
    }
    push('')
  }

  if (report.duplicates.length > 0) {
    push('## 疑似重复处罚')
    push('')
    for (const pair of report.duplicates) push(`- ${pair.a} 与 ${pair.b}：${pair.reason}`)
    push('')
  }

  // ── 边界与元信息：全部下沉到文末 ──
  push('## 本次没判什么')
  push('')
  for (const item of report.notEvaluated) push(`- ${item}`)
  push('')
  push(`> ${report.disclaimer}`)
  push(`> 规则集 schema \`${report.schemaVersion}\` · 判的是「这份交付有没有把任务接住」，不鉴定作者、不评人。`)

  const text = lines.join('\n')

  const headingLevel = Number(options.headingLevel ?? 2)
  if (!Number.isFinite(headingLevel) || headingLevel <= 2) return text
  const shift = headingLevel - 2
  return text.replace(/^(#{1,6})\s/gmu, (_match, hashes) => `${'#'.repeat(Math.min(6, hashes.length + shift))} `)
}
