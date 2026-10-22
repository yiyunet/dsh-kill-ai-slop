// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/layers.mjs
/**
 * 四层十二格 —— 0.5.x 的判分核心。
 *
 * ═══ 与 0.3.x 的两处根本不同 ═══════════════════════════════════════
 *
 * ① **方向相反。**
 *    0.3.x：分数越高越差（100 = 全是 slop）。
 *    本版：**分数越高越好**（100 = 本阶段必要工作已完成）。
 *    同一份文件在 0.3.x 印 80、在本版印 80，含义正好相反。
 *    ⇒ 所以这是破坏性变更，必须换大版本号；跨版本的分数**不可比**。
 *
 * ② **判分主体不同。**
 *    0.3.x：引擎自己用词表算 severity —— 于是"字段齐全"能换来高分，
 *           而"字段齐全但没人做判断"恰恰是要抓的东西。
 *    本版：引擎**只产证据**（引文、位置、可复算数字），0–4 由人/Agent 给。
 *           本文件不猜分数，只负责三件事：
 *             收进来的格子是否合法 → 算术 → 结论
 *           「可争论的是判断，不可争论的是算术」——这条分工写在这里。
 *
 * ═══ 判断单位 ═════════════════════════════════════════════════════
 *
 * 不是"有没有某个字段"，是"**还剩哪些本该由提交者完成的工作**"。
 * 所以每一格的分不是数出来的，是判出来的；而**扣分**另有一道闸：
 * 必须四条件同时成立（见 CONDITIONS），缺一条就降级为建议。
 * 闸只认"成立/不成立"，不认"大概算缺"。
 *
 * ═══ 关于「待确认」 ═══════════════════════════════════════════════
 *
 * 未知**不能当低分，也不能当满分**。
 * 一个看不见的附件，既不能证明"缺了"，也不能证明"公司已经有了"——
 * 这两种推理都是拿"我不知道"去填一个结论。
 * ⇒ 未知就标 `undetermined`，它不进分母，也不改变任何一格的分数。
 */

/** 四层。权重是**初案，未经校准**，不是标准。 */
export const LAYERS = {
  intent: {
    id: 'intent',
    label: '意图',
    weight: 0.20,
    question: '交付是否推动了任务要求的结果',
    slopPattern: '把要求落地的任务，转换成背景介绍、问题罗列或泛泛建议',
    cells: ['I1', 'I2', 'I3'],
  },
  strategy: {
    id: 'strategy',
    label: '策略',
    weight: 0.35,
    question: '作者是否完成必要的判断与选择',
    slopPattern: '提供大量信息和选项，最终仍由接收者决定方向、重点和取舍',
    cells: ['S1', 'S2', 'S3'],
  },
  execution: {
    id: 'execution',
    label: '执行',
    weight: 0.35,
    question: '作者是否完成把选择转成行动所需的组织工作',
    slopPattern: '方向已经提出，但接收者还要重新拆任务、排先后、协调关键依赖',
    cells: ['E1', 'E2', 'E3'],
  },
  expression: {
    id: 'expression',
    label: '表达',
    weight: 0.10,
    question: '接收者能否准确理解和使用已有成果',
    slopPattern: '信息被冗余、模糊、矛盾或结构混乱遮住，需要重新整理才能用',
    cells: ['V1', 'V2', 'V3'],
  },
}

export const LAYER_ORDER = ['intent', 'strategy', 'execution', 'expression']

/**
 * **显示顺序**：表达 → 策略 → 执行 → 意图。
 *
 * ★ 与 `LAYER_ORDER` 不是同一个东西，**不要合并**：
 *   · `LAYER_ORDER` 是模型的推理链（任务 → 选择 → 组织 → 接收），用来解释四层为什么这么排；
 *   · `DISPLAY_ORDER` 是**读的顺序**：先给最好读的表达，把"接住什么任务"放最后，
 *     作为需要下判断的那一项。
 *
 * 两处顺序曾经各写各的（面板一套、报告一套），读者看到同一份结果两个排法。
 * 现在**只有这一份**：报告 markdown、面板、引擎自检都读它。
 */
export const DISPLAY_ORDER = ['expression', 'strategy', 'execution', 'intent']

/** 十二格在报告里的顺序：跟着 DISPLAY_ORDER 分组，组内保持原有次序。 */
export const CELL_DISPLAY_ORDER = DISPLAY_ORDER.flatMap(id => LAYERS[id].cells)

/**
 * 十二格。
 *
 * ★ I2 叫「用途对齐」，**不叫「结果推进」**。
 *   曾被改成"产出可直接用的东西"，两个问题：
 *     ① 与执行层 E1（做什么/产出什么）重复，同一件事扣两遍；
 *     ② 会让一份「局部有用、整体没接住任务」的材料拿高分 —— 而那正是最该抓的。
 *   意图层三格的完整含义是：回应真问题（I1）、支撑当前决定（I2）、分清本轮与后续（I3）。
 */
export const CELLS = {
  I1: {
    id: 'I1', layer: 'intent', label: '任务对齐',
    question: '是否回应真正要求解决的问题',
    lookFor: '有没有把要落地的事做成落地的事；有无偷换成背景介绍、问题罗列、泛泛建议',
  },
  I2: {
    id: 'I2', layer: 'intent', label: '用途对齐',
    question: '是否提供接收者当前需要的决策或行动支持',
    lookFor: '接收者此刻要批什么/定什么/做什么；该决定所需信息给了几成',
  },
  I3: {
    id: 'I3', layer: 'intent', label: '阶段与边界对齐',
    question: '是否完成本轮应做的工作，并处理好后续、协作和审批的衔接',
    lookFor: '本轮/下一阶段/持续/需批准/需协作 是否分得清；等待期能不能先干',
  },
  S1: {
    id: 'S1', layer: 'strategy', label: '选择',
    question: '是否完成了选择（不是把选项留给接收者）',
    lookFor: '有无明确建议与当前重点；是否只罗列可能性',
  },
  S2: {
    id: 'S2', layer: 'strategy', label: '判断依据',
    question: '该做的判断是否做了；依据是否足以支持该选择',
    lookFor: '是否仍由接收者决定方向/重点/取舍；有无未说明的假设直接连到结果',
  },
  S3: {
    id: 'S3', layer: 'strategy', label: '取舍与调整条件',
    question: '需要取舍时是否完成取舍；条件变化后是否知道何时调整',
    lookFor: '做/不做什么；调整触发条件是否落到本轮会用上的节点',
  },
  E1: {
    id: 'E1', layer: 'execution', label: '下一步可启动',
    question: '接收者能否直接开工（不需重新拆任务）',
    lookFor: '做什么、产出什么、由谁承担',
  },
  E2: {
    id: 'E2', layer: 'execution', label: '推进安排可协调',
    question: '接收者能否直接排期（不需重新排先后、不需自找依赖）',
    lookFor: '时间、周期、先后、依赖、资源；等待期能做什么要不要等',
  },
  E3: {
    id: 'E3', layer: 'execution', label: '结果可检查',
    question: '能否判断阶段完成、发现偏差（不需重新设计验收）',
    lookFor: '判定标准、偏差发现机制、继续/调整/停止的判据',
  },
  V1: {
    id: 'V1', layer: 'expression', label: '准确完整',
    question: '数字、定义、条件、限制是否准确；错误是否会导致误判',
    lookFor: '确认的算术错误与内部不一致**计入**；外部业务事实无法核实则标范围',
  },
  V2: {
    id: 'V2', layer: 'expression', label: '逻辑可追踪',
    question: '结论—依据—行动能否对应；有无推论跳跃或前后矛盾',
    lookFor: '可从上文协调的表述不算矛盾；未证实的断言属核实范围，不判逻辑缺陷',
  },
  V3: {
    id: 'V3', layer: 'expression', label: '接收成本',
    question: '是否需要重新整理才能用',
    lookFor: '结构、冗余、术语、篇幅；"更好找"不算缺口',
  },
}

export const CELL_ORDER = ['I1', 'I2', 'I3', 'S1', 'S2', 'S3', 'E1', 'E2', 'E3', 'V1', 'V2', 'V3']

/** 格子的四种状态。`unrated` 与 `undetermined` 都不进分母。 */
export const CELL_STATES = {
  unrated: '未评',
  rated: '已评',
  notApplicable: '不适用',
  undetermined: '待确认',
}

/**
 * 归属：这件事**是谁的工作**。
 *
 * ★ 只有 `submitter` 才可能构成扣分。
 *   但归属本身**不是扣分开关** —— 它只是四个必要条件之一（见 CONDITIONS）。
 *   早期版本把"属于提交者"当成唯一开关，结果凡是"提交者的活"都能扣，
 *   于是又回到了"发现某个细节可以补充就扣分"的老路上。
 */
export const ATTRIBUTIONS = {
  submitter: '提交者',
  'other-party': '他人 / 审批方',
  undetermined: '待确认（无法判定归谁）',
}

/**
 * 扣分四条件 —— **必须同时成立**，缺一条就只能列为建议。
 *
 * 为什么把 C2 写成"或须为该决定准备必要信息"：
 *   决定权不在提交者，不等于提交者没有义务。
 *   例：拿货价由上级批，但"推荐价 + 理由 + 与公司标准的关系"是提交者该准备的。
 *   早先版本把"审批方的事"整类划走，等于把提交者的另一半义务也豁免了。
 */
export const CONDITIONS = {
  C1: {
    id: 'C1',
    label: '当前阶段必须完成',
    test: '这件事影响的是本轮要做的决定或动作，不是更晚的事',
    failHint: '写不出"这个决定在第几周/哪个节点需要" → 降为建议',
  },
  C2: {
    id: 'C2',
    label: '属于提交者职责（或须为其准备决定所需信息）',
    test: '决定权可能在别人，但为这个决定准备信息是不是提交者的活',
    failHint: '纯他人/审批方的判断，且提交者无信息准备义务 → 不扣',
  },
  C3: {
    id: 'C3',
    label: '全文确实未充分完成',
    test: '闸 2 合并同一事项多处说明之后，仍未完成',
    failHint: '分散在别处已完成 → 不扣（只可能进 V3 的查找成本）',
  },
  C4: {
    id: 'C4',
    label: '影响当前决定或行动',
    // ★ 0.7.12：不再是"必须阻塞"。按程度分三级 —— 以前的措辞是"会卡住哪个具体决定"，
    //   读起来像"只有完全推不动才算影响"，于是模型为了凑出扣分把影响写成"无法推进"。
    test: '不补它，接收者会多付出一份实际劳动：多问一次 / 多算一遍 / 多核对一处，或直接卡住某个决定与动作',
    failHint: '写不出这份多出来的劳动在哪 → 降为建议，不扣',
  },
}

export const CONDITION_ORDER = ['C1', 'C2', 'C3', 'C4']

/**
 * 0–10 锚点（0.5 一档，共 21 个可用值）：统一按「剩余工作程度」判，**不看字段数量**。
 *
 * ★ 0.7.8：从 0–4 改成 0–10。老板核对后拍的 ——
 *   0–4 只有 5 档，层分取最弱格之后只能落在 0/25/50/75/100 五个点上，
 *   综合分最小可分辨变化 2.5 分。**"扣分太小"的根子不在权重，在档位。**
 *   改成 0–10 后层分有 21 个取值，综合分最小步长 0.5 分。
 *
 * 10 分的含义是「本阶段该做的做完了」，**不是**「方案无懈可击、结果一定达成」。
 * 一篇短而能推进的文件可以拿 10；篇幅完整、字段齐全也可能只有 2。
 */
export const SCORE_MAX = 10
export const SCORE_STEP = 0.5

export const SCORE_ANCHORS = {
  0: { label: '未形成成果', test: '未形成相关有效成果，或明显偏离任务，需要重新开展' },
  1: { label: '零散素材', test: '有零散素材，未形成可用成果，接收者要从零组织' },
  2: { label: '材料与方向', test: '只给了材料与方向，接收者要自己做核心工作' },
  3: { label: '关键工作大部未做', test: '主要成果成型，但核心判断仍要接收者自己完成' },
  4: { label: '关键信息缺一块', test: '关键信息缺失，接收者必须回来问一次才能推进主决策' },
  5: { label: '关键判断做了一半', test: '方向有了、数没有；结论有了、依据没有；动作有了、验收没有' },
  6: { label: '影响次要动作', test: '缺口已影响一个次要动作，不补会返工，但主决策仍可推进' },
  7: { label: '局部补充', test: '有一至两处局部缺口，接收者问一句就能继续' },
  8: { label: '一处小不精确', test: '有一处不精确，但接收者不用问、自己就能定下来' },
  9: { label: '仅措辞瑕疵', test: '只剩排版/措辞/编号这类问题，不改变任何判断' },
  10: { label: '本阶段已完成', test: '本阶段必要工作已完成，接收者可以履行正常决策、审批或协作职责' },
}

/** 阈值：全部由 SCORE_MAX 推出，改档位时只改一处。 */
export const GAP_AT = SCORE_MAX          // < 它 = 有缺口（要进扣分闸）
export const CRITICAL_AT = 5             // ≤ 它 = 关键缺口，层内必须标出
export const REWORK_AT = 2.5             // ≤ 它 = 核心方向要重做
export const STARTABLE_AT = 7.5          // ≥ 它 = "已给出的部分"可推进

/**
 * 推进结论 —— 按「关键缺口**影响哪些工作**」定，**不是**按最低分换算。
 *
 * ★ 为什么废掉"任一格 ≤N 就重新形成方案"：
 *   表达层某格 1 分，未必需要重做业务方案；
 *   一个关键执行条件待确认，也未必阻止名录搜集与材料准备。
 *   分数负责概览，结论负责指导行动 —— 两者不能互相换算。
 *
 * 四类可以**并存**，所以返回的是 parts 而不是单选一个档。
 */
export const READINESS = {
  rework: { id: 'rework', label: '重新形成相关方案', when: '核心方向需要重新选择' },
  supplement: { id: 'supplement', label: '补充相关部分', when: '局部安排不足' },
  'advance-unaffected': { id: 'advance-unaffected', label: '先推进不受影响的工作', when: '部分条件未确认' },
  proceed: { id: 'proceed', label: '可以推进', when: '当前必要工作充分' },
}

/**
 * 零评分时的结论 —— **不是四类工作结论之一**，而是「没有判断可作」。
 *
 * ★ 0.5.0 实测踩到：十二格全未评时，`readinessOf` 里"没有缺口、没有待确认"
 *   会让它落到最后一个分支，输出**「可以推进」**。
 *   这和前面三次是同一个错 —— 把"我没看"报成"没问题"，只是这次换到了**结论位**。
 *   所以给它单独一个出口；并且**故意不放进 `READINESS`**：
 *   放进去会让"未判"看起来像一种正常的推进结论。
 */
export const UNRATED_READINESS = {
  id: 'unrated',
  label: '未判定 —— 十二格全部未评，没有任何判断可以支撑推进结论',
  when: '没有评分就没有判断；「未判」既不是「可以推进」，也不是「需要重做」',
}

// 0–10、0.5 一档：先夹到区间内，再吸到最近的半档上。
// 不做四舍五入到整数 —— 那等于把 0–10 又退回 0–4 的粒度。
const clampScore = value => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  const snapped = Math.round(numeric / SCORE_STEP) * SCORE_STEP
  return Math.max(0, Math.min(SCORE_MAX, snapped))
}
const round1 = value => Math.round(value * 10) / 10

/** 十二个格子全部 `unrated` 的空白模板。 */
export function emptyCells() {
  return CELL_ORDER.map(id => ({
    id,
    layer: CELLS[id].layer,
    label: CELLS[id].label,
    state: 'unrated',
    score: null,
    attribution: 'undetermined',
    deduction: null,
    note: '',
  }))
}

/**
 * 校验并规范化一格。
 * 非法输入不猜、不修，直接标 `unrated` 并把原因留在 note 里 ——
 * 猜一个分数出来的代价比留空大得多。
 */
export function normalizeCell(id, input = {}) {
  const definition = CELLS[id]
  if (definition === undefined) throw new Error(`未知的检查点：${id}`)

  const base = {
    id, layer: definition.layer, label: definition.label,
    state: 'unrated', score: null, attribution: 'undetermined', deduction: null, note: '',
    // `human` = 人/Agent 给的；`machine` = 引擎从已有证据推的（见 deriveCells）。
    // 两者**不能混着看**：机器分没有归属与四条件依据，不能构成扣分。
    source: 'human',
  }

  if (input === null || typeof input !== 'object') return base

  const note = typeof input.note === 'string' ? input.note : ''
  const source = input.source === 'machine' ? 'machine' : 'human'
  // 状态接受两种拼法（`notApplicable` / `not-applicable`）——
  // 面板传 camelCase、Agent 传 kebab-case 都遇到过，认一种就会静默退回 unrated。
  const rawState = typeof input.state === 'string' ? input.state : ''
  const state = rawState === 'not-applicable' ? 'notApplicable' : rawState

  if (state === 'notApplicable') {
    return { ...base, state: 'not-applicable', note, source }
  }
  if (state === 'undetermined') {
    return { ...base, state: 'undetermined', attribution: 'undetermined', note, source }
  }

  // 已有分数 → rated；分数缺失但自称 rated → 退回 unrated（不填 0，也不填满分）
  if (input.score === null || input.score === undefined) {
    const claimedRated = rawState === 'rated'
    return { ...base, source, note: claimedRated && note === '' ? '自称已评但没有分数' : note }
  }
  const numeric = Number(input.score)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > SCORE_MAX) {
    return { ...base, note: `分数 ${JSON.stringify(input.score)} 不在 0–${SCORE_MAX} 内` }
  }

  const attribution = typeof input.attribution === 'string' && input.attribution in ATTRIBUTIONS
    ? input.attribution
    : 'undetermined'

  return {
    ...base,
    state: 'rated',
    score: clampScore(numeric),
    attribution,
    deduction: input.deduction ?? null,
    note,
    source,
  }
}

/** 规范化十二格；缺的补 `unrated`。 */
export function normalizeCells(input) {
  const source = Array.isArray(input)
    ? Object.fromEntries(input.filter(Boolean).map(cell => [cell.id, cell]))
    : (input ?? {})
  return CELL_ORDER.map(id => {
    const normalized = normalizeCell(id, source[id] ?? {})
    const original = source[id]
    if (original === null || typeof original !== 'object') return normalized
    // ★ 保留调用方带的评审元数据（evidence / mergedFrom / claimBasis / withdrawal / rejected）。
    //   normalizeCell 只认那 6 个标准字段，直接返回会把引文明细丢掉 ——
    //   而报告的「判定与证据」一节正要印它。标准字段一律以 normalizeCell 的结果为准。
    const extras = {}
    for (const [key, value] of Object.entries(original)) {
      if (key in normalized) continue
      extras[key] = value
    }
    return { ...normalized, ...extras }
  })
}

/**
 * 一层的分。
 *
 * ★ 0.7.7：层分 = **本层最弱的一格** ÷ 4 × 100，不再是平均分。
 *
 *   为什么改：四层问的都是"这一步该做的做完了吗"，是 all-of 判定，不是加法。
 *   平均等于承认"两个满分格可以顶掉一个没做完的格"——实测里
 *   `V1=3 · V2=4 · V3=4` 印出 91.7 分，读者看到的是一份没什么问题的文件，
 *   而 V1 那句判定明明是"两处口径未统一，接收者不知道第 6 项要不要批"。
 *   百分制下 4 档制的 1 分之差被摊成 8 分，**问题被平均值盖住了**。
 *   取最弱格之后：一格 3 分 → 这一层就是 75，扣分不再可忽略。
 *
 *   `mean` 仍然保留，只作参考展示（让人看得见"平均洗掉了多少"），不参与综合分。
 *
 * `unrated` / `undetermined` / `not-applicable` **不进算式**：
 * 把"我没看"算进分母，等于把没看的格子当成 0 分或满分，两种都是撒谎。
 */
export function scoreLayer(cells, layerId) {
  const definition = LAYERS[layerId]
  if (definition === undefined) throw new Error(`未知的层：${layerId}`)

  const members = cells.filter(cell => definition.cells.includes(cell.id))
  const rated = members.filter(cell => cell.state === 'rated')
  const pending = members.filter(cell => cell.state === 'undetermined')
  const skipped = members.filter(cell => cell.state === 'not-applicable')
  const missing = members.filter(cell => cell.state === 'unrated')

  const result = {
    id: layerId,
    label: definition.label,
    weight: definition.weight,
    question: definition.question,
    cells: members.map(cell => cell.id),
    rated: rated.length,
    total: members.length,
    pending: pending.map(cell => cell.id),
    notApplicable: skipped.map(cell => cell.id),
    unrated: missing.map(cell => cell.id),
    // 层内出现 ≤2 分格 → 必须标「含关键缺口」。
    // 层内平均会让 2 分与 4 分互相抵消（4+2+4 → 83 看起来不错），
    // 所以这个标记不能靠读者从四个数字里自己发现。
    criticalGapCells: rated.filter(cell => cell.score <= CRITICAL_AT).map(cell => cell.id),
    value: null,
    display: null,
    mean: null,
    weakest: [],
    withheld: false,
    withheldReason: '',
  }

  if (members.length === 0) {
    // ★ 实测踩到过：调用方只传了一部分格子时，本层的 `members` 是空的。
    //   而下面"整层不适用"的判据是 `skipped.length === members.length` —— 0 === 0 成立，
    //   于是**一个格子都没收到的层被当成"文件不涉及"**，权重被归一化掉，
    //   综合分反而照算了。这与"我没看 ≠ 没问题"是同一个错，只是换了个位置。
    result.withheld = true
    result.withheldReason = `${definition.label}层没有收到任何格子 —— 不出层分（收不到≠不适用）。`
    return result
  }

  if (rated.length === 0) {
    result.withheld = true
    if (skipped.length === members.length) {
      // 「整层不适用」与「整层还没评」都算不出分，但报告里必须分开说：
      // 前者是文件不涉及，后者是我们没看 —— 混成一句就成了"没问题"。
      result.withheldReason = `${definition.label}层整层不适用 —— 不出层分，剩余层权重将归一。`
    } else if (pending.length > 0 && missing.length === 0) {
      result.withheldReason = `${definition.label}层有 ${pending.length} 格待确认、无已评格 —— 不出层分（待确认不等于低分）。`
    } else {
      result.withheldReason = `${definition.label}层没有已评格 —— 不出层分（不是 0 分）。`
    }
    return result
  }

  const scores = rated.map(cell => cell.score)
  const weakest = Math.min(...scores)
  const mean = scores.reduce((sum, score) => sum + score, 0) / rated.length

  // 参考值：平均分（旧算法）。只展示，不参与综合分 —— 它的用处是让人一眼看见
  // "平均把一个没做完的格洗成了多少分"。
  result.mean = round1((mean / SCORE_MAX) * 100)
  // 并列最弱的格要全列出来：补其中一个没用，得一起补。
  result.weakest = rated.filter(cell => cell.score === weakest).map(cell => cell.id)
  result.value = round1((weakest / SCORE_MAX) * 100)
  result.display = Math.round(result.value)
  result.hasCriticalGap = result.criticalGapCells.length > 0
  return result
}

/** 四层一起算。 */
export function scoreAllLayers(cells) {
  return LAYER_ORDER.map(layerId => scoreLayer(cells, layerId))
}

/**
 * 综合分 = Σ（层分 × 权重）。
 *
 * 一条不出分的规矩：
 *   任何**有权重**的层 withhold（不是因为 N/A）→ 综合分不出。
 *   分母少一块却照算平均，分数会往上跳，而读者只会看见"变好了"。
 *
 * ★ 0.7.7：待确认项**不再挡住综合分**。
 *   旧规则是"待确认项若会翻转判定 → 综合分不出"，实测后果是：
 *   一份 11/12 格都判完的文件，面板上综合分是「—」，读者拿不到任何数。
 *   而且那两个未定项（小额预算算不算第 6 项、有效触达怎么定义）
 *   **已经通过 V1/S1/E3 的扣分进了分数** —— 再拿同一件事阻止出分，
 *   等于同一件事罚两次。
 *   现在：分数照出，问题在「待确认」一节单列，并给
 *   「未评的格若评为 0 分，综合分低到几分」（`floor`）作为下限。
 */
export function compositeOf(layerScores, { blocksComposite = false, blockReason = '' } = {}) {
  const base = {
    value: null,
    display: null,
    withheld: false,
    withheldReason: '',
    weightsUsed: {},
    normalized: false,
    // 有没有"会翻转判定的未知项"。只作披露，不再阻挡出分。
    unresolved: blocksComposite === true,
    unresolvedNote: blocksComposite === true
      ? (blockReason === '' ? '存在会改变判定的待确认项 —— 分数按已评格出，未定项在下文单列。' : blockReason)
      : '',
    layersWithCriticalGap: layerScores.filter(layer => layer.withheld === false && layer.hasCriticalGap).map(layer => layer.id),
    weightDiscrimination: null,
  }

  // ★ "整层不适用" ≠ "整层还没评"。
  //   两者都算不出层分，但处理完全相反：不适用要归一化权重（否则总分被系统性压低），
  //   没评只能不出分（归一化等于把"还没做"洗成"不受影响"）。
  //   判据取**显式标了 not-applicable** 的格数，且 `total > 0` ——
  //   没有 total 就没有分母，"0 个不适用 / 0 格"不是不适用，是空。
  const na = layerScores.filter(layer => layer.total > 0 && layer.notApplicable.length === layer.total)
  const withheld = layerScores.filter(layer => layer.withheld && !na.includes(layer))
  if (withheld.length > 0) {
    return {
      ...base,
      withheld: true,
      withheldReason: `${withheld.map(layer => layer.label).join('、')}层未出层分（${withheld.map(layer => layer.withheldReason).join('；')}）—— 综合分不出。`,
    }
  }

  // 整层不适用 → 剩余层按原权重归一化，并显式说明「某层不适用，权重已归一」。
  // 不归一化会让总因"不适用"被系统性压低，而那不是文件的错。
  const active = layerScores.filter(layer => !na.includes(layer))
  const activeWeight = active.reduce((sum, layer) => sum + layer.weight, 0)
  if (active.length === 0 || activeWeight === 0) {
    return { ...base, withheld: true, withheldReason: '没有任何一层出分，综合分不出。' }
  }

  const weightsUsed = {}
  let sum = 0
  for (const layer of active) {
    const weight = na.length === 0 ? layer.weight : layer.weight / activeWeight
    weightsUsed[layer.id] = round1(weight * 1000) / 1000
    sum += layer.value * weight
  }

  const displays = active.map(layer => layer.display)
  return {
    ...base,
    value: round1(sum),
    display: Math.round(sum),
    weightsUsed,
    normalized: na.length > 0,
    normalizedNote: na.length > 0
      ? `${na.map(layer => layer.label).join('、')}层不适用，剩余 ${active.map(layer => layer.label).join('、')} 层权重已归一。`
      : '',
    // 四层同分时权重失效 —— 这个事实必须披露，不能让读者以为权重"算过了"。
    weightDiscrimination: new Set(displays).size > 1,
  }
}

/**
 * 扣分是否成立 —— 四条件 AND。
 * @returns {{ok: boolean, missing: string[], reasons: string[]}}
 */
export function validateDeduction(cell) {
  const deduction = cell?.deduction ?? {}
  const missing = []
  const reasons = []

  for (const id of CONDITION_ORDER) {
    const hit = deduction[id] ?? deduction[id.toLowerCase()]
    const passed = hit === true || (typeof hit === 'string' && hit.trim() !== '')
    if (!passed) {
      missing.push(id)
      reasons.push(`${id}（${CONDITIONS[id].label}）未说明：${CONDITIONS[id].failHint}`)
    }
  }

  if (cell?.attribution === 'undetermined') {
    missing.push('attribution')
    reasons.push('归属待确认：不知该由谁完成时，不得扣分（也不得默认归提交者）。')
  } else if (cell?.attribution === 'other-party') {
    missing.push('attribution')
    reasons.push('归属为他人/审批方：不得扣分，应列为审批要件或协作事项。')
  }

  return { ok: missing.length === 0, missing, reasons }
}

/**
 * 把十二格里所有"声称扣分"的格子过一遍闸。
 * 未通过的不是删掉，而是**降级**：分数保留，扣分理由降为建议。
 */
export function auditDeductions(cells) {
  const accepted = []
  const downgraded = []
  const machine = []
  for (const cell of cells) {
    if (cell.state !== 'rated' || cell.score >= GAP_AT) continue
    // ★ 0.7.0：机器给分的分支已移除。分数只能来自通读后的判定，
    //   所以这里不再需要"机器格绕闸"的例外 —— 那道例外本身就是 0.6.0 的病。
    //   `machine` 保留空数组只为向后兼容报告的渲染代码。
    const verdict = validateDeduction(cell)
    if (verdict.ok) accepted.push({ cell: cell.id, score: cell.score, reasons: verdict.reasons })
    else downgraded.push({ cell: cell.id, score: cell.score, missing: verdict.missing, reasons: verdict.reasons })
  }
  return { accepted, downgraded, machine }
}

/**
 * 推进结论。
 *
 * @param {object[]} cells 十二格
 * @param {{gaps?: object[], pending?: object[]}} options
 *   gaps:    [{ cell, affects: 'direction'|'local'|'none', work: '会卡住的那件事' }]
 *   pending: [{ label, blocks?: boolean, work }]
 */
export function readinessOf(cells, options = {}) {
  const gaps = Array.isArray(options.gaps) ? options.gaps : []
  const pending = Array.isArray(options.pending) ? options.pending : []
  const ratedCells = cells.filter(cell => cell.state === 'rated')

  const parts = []
  const canStartNow = []
  const mustWait = []
  const mustDo = []

  const direction = gaps.filter(gap => gap.affects === 'direction')
  const local = gaps.filter(gap => gap.affects === 'local' || gap.affects === undefined)
  const blocking = pending.filter(item => item.blocks === true)

  // ★ 零评分 → 没有判断可作，绝不允许落到下面的「可以推进」分支。
  if (ratedCells.length === 0) {
    const blockingLabels = blocking.map(item => item.label ?? item.cell ?? '待确认项')
    return {
      code: UNRATED_READINESS.id,
      parts: [{ id: UNRATED_READINESS.id, label: UNRATED_READINESS.label, when: UNRATED_READINESS.when }],
      text: UNRATED_READINESS.label,
      mustDo: [],
      canStartNow: pending.filter(item => item.blocks !== true)
        .map(item => `不依赖「${item.label ?? item.cell ?? '待确认项'}」的部分可以继续`),
      mustWait: blockingLabels,
      cellsAtOrBelowTwo: [],
      blockingPending: blockingLabels,
    }
  }

  if (direction.length > 0 || ratedCells.some(cell => cell.score <= REWORK_AT)) {
    parts.push(READINESS.rework)
    for (const gap of direction) mustDo.push(`${gap.cell ?? '—'}：${gap.work ?? '核心方向需要重新选择'}`)
  }
  if (local.length > 0) {
    parts.push(READINESS.supplement)
    for (const gap of local) mustDo.push(`${gap.cell ?? '—'}：${gap.work ?? '局部安排不足'}`)
  }
  if (pending.length > 0) {
    parts.push(READINESS['advance-unaffected'])
    for (const item of pending) {
      const label = item.label ?? item.cell ?? '待确认项'
      if (item.blocks === true) mustWait.push(label)
      else canStartNow.push(`不依赖「${label}」的部分可以继续`)
    }
  }
  if (parts.length === 0) parts.push(READINESS.proceed)

  const primary = parts[0]
  const text = parts.map(part => part.label).join(' ＋ ')

  return {
    code: primary.id,
    parts: parts.map(part => ({ id: part.id, label: part.label, when: part.when })),
    text,
    mustDo,
    canStartNow,
    mustWait,
    // 仅供参考：分数负责概览，结论负责指导行动，两者不互相换算。
    cellsAtOrBelowTwo: ratedCells.filter(cell => cell.score <= CRITICAL_AT).map(cell => cell.id),
    blockingPending: blocking.map(item => item.label ?? item.cell ?? '待确认项'),
  }
}

/**
 * 一次算完：格子 → 层分 → 综合分 → 扣分闸 → 推进结论。
 * 报告与客户端都读这里，避免同一件事两个说法。
 */
export function evaluateLayers({ cells, gaps = [], pending = [], blocksComposite = false, blockReason = '' } = {}) {
  const normalized = normalizeCells(cells)
  const layerScores = scoreAllLayers(normalized)
  const deductions = auditDeductions(normalized)
  const readiness = readinessOf(normalized, { gaps, pending })

  // 待确认项若会翻转判定 → 综合分自动不出，不需要调用方再传一次 blocksComposite。
  const flips = pending.some(item => item.blocks === true)
  const composite = compositeOf(layerScores, {
    blocksComposite: blocksComposite === true || flips,
    blockReason,
  })

  // ★ 0.7.7：没进算式的格（未评／待确认）如果评为 0 分，综合分低到几分。
  //   不给这个下限，"我没看"就会变成对提交者有利的选择 —— 不评反而分数更高。
  const softCells = normalized.map(cell => (cell.state === 'unrated' || cell.state === 'undetermined')
    ? { ...cell, state: 'rated', score: 0 }
    : cell)
  const softIds = softCells.filter((cell, index) => cell !== normalized[index]).map(cell => cell.id)
  const softScore = compositeOf(scoreAllLayers(softCells), {
    blocksComposite: blocksComposite === true || flips,
    blockReason,
  })
  composite.floor = softScore.withheld === true ? null : softScore.display
  composite.floorCells = softIds

  // ★ 0.7.7：每一处缺口值多少分 —— 把这一格单独补到满分，综合分涨多少。
  //   旧报告只印"V1（3 分）"这种字样，读者不知道它到底该不该现在动手；
  //   印成一个可比的数，缺口才有价格。
  const impacts = normalized
    .filter(cell => cell.state === 'rated' && cell.score < GAP_AT)
    .map(cell => {
      const lifted = normalized.map(item => (item.id === cell.id ? { ...item, score: SCORE_MAX } : item))
      const next = compositeOf(scoreAllLayers(lifted), {
        blocksComposite: blocksComposite === true || flips,
        blockReason,
      })
      const layerId = CELLS[cell.id]?.layer
      const tied = (layerScores.find(layer => layer.id === layerId)?.weakest ?? []).filter(id => id !== cell.id)
      // 用一位小数的 `value` 而不是四舍五入后的 `display`：权重 10% 的层里
      // 一处缺口只值 2.5 分，按整数相减会算成 +1 甚至 0，那就又变成"扣分太小"。
      const before = composite.value
      const after = next.withheld === true ? null : next.value
      return {
        cell: cell.id,
        label: cell.label,
        layer: layerId,
        from: cell.score,
        to: SCORE_MAX,
        before,
        after,
        delta: after === null || before === null ? null : round1(after - before),
        // 并列最弱：只补这一格没用，得一起补 —— 报告要写清，否则 "+0" 会被当成"补了没用"。
        tied,
      }
    })

  const lowCells = normalized.filter(cell => cell.state === 'rated' && cell.score <= CRITICAL_AT)

  return {
    version: 'layers/0.7.0',
    weights: Object.fromEntries(LAYER_ORDER.map(id => [id, LAYERS[id].weight])),
    weightsCalibrated: false,
    direction: 'higher-is-better',
    comparableAcrossVersions: false,
    cells: normalized,
    layers: layerScores,
    composite,
    deductions,
    // 每一处缺口值多少分（把该格补到满分，综合分涨多少）。
    impacts,
    // 调用方传进来的未知项 —— 报告要把它列出来，否则读者只看到"综合分不出"却不知道缺什么。
    pendingItems: pending.map(item => ({
      label: item.label ?? item.cell ?? '待确认项',
      blocks: item.blocks === true,
      work: item.work ?? '',
    })),
    readiness:
      deductions.downgraded.length > 0
        ? {
          ...readiness,
          downgradedNote: `${deductions.downgraded.length} 处扣分未过四条件闸，已降为建议：`
            + deductions.downgraded.map(item => item.cell).join('、'),
        }
        : readiness,
    headline: {
      available: composite.withheld !== true,
      display: composite.display,
      layerDisplays: Object.fromEntries(layerScores.map(layer => [layer.id, layer.display])),
      lowCells: lowCells.map(cell => ({ id: cell.id, score: cell.score })),
    },
    // 没有任何格被评 → 明确说"这不是 0 分"
    isEmpty: normalized.every(cell => cell.state === 'unrated'),
  }
}

/**
 * 把 0.3.x 的 A/B 维度映射成十二格的**证据线索**（只指路，不给分）。
 *
 * 为什么要留这个映射：用户手上的是 0.3.x 的引擎，它能数出"哪句是套话、
 * 哪条动作没责任人"。这些数字对新的十二格是**证据**，不是分数。
 * 直接丢掉等于让每份报告从零开始读。
 */
export const DIMENSION_HINTS = {
  A1: ['V3'],
  A2: ['V3'],
  A3: ['V3'],
  A4: ['V1'],
  A5: ['V3'],
  B1: ['I1'],
  B2: ['I2'],
  B3: ['S2'],
  B4: ['V2'],
  B5: ['S1', 'S3'],
  B6: ['E1', 'E2'],
}

/**
 * 生成十二格的证据线索表。
 * @param {object[]} dimensions audit 报告里的 dimensions
 */
export function hintCells(dimensions) {
  const hints = Object.fromEntries(CELL_ORDER.map(id => [id, []]))
  for (const dimension of Array.isArray(dimensions) ? dimensions : []) {
    for (const cellId of DIMENSION_HINTS[dimension.id] ?? []) {
      hints[cellId].push({
        from: dimension.id,
        label: dimension.label,
        state: dimension.state,
        summary: dimension.summary ?? '',
        hits: (dimension.hits ?? []).length,
      })
    }
  }
  return hints
}

/** 一句话说明「这一格为什么还没分」——报告与面板共用。 */
export function whyUnscored(cell) {
  if (cell.state === 'rated') return ''
  if (cell.state === 'undetermined') return `待确认：${cell.note === '' ? '现有证据不足以判定' : cell.note}`
  if (cell.state === 'not-applicable') return `不适用：${cell.note === '' ? '该检查点不适用于本文件' : cell.note}`
  return '未评：0–4 由人/Agent 判定，引擎只提供证据'
}

/* ───────────────── 机器评估（0.6.0）───────────────── */

/**
 * 每一格的分数**从哪来** —— 报告里原样印出来，可逐条核。
 *
 * ★ 为什么要有机器评估：0.5.x 的设计是「0–4 由人给」，实测下来用户不接受 ——
 *   他要的是"工具帮我看看"，不是"工具给我一张表让我自己打分"。
 *   所以引擎必须自己给分；但**能给分的只有它真的有证据的那七格**，
 *   其余五格保持 `待确认`，不许编。
 *
 * ★ 机器分只给 **2–4**，永远不给 0/1：
 *   0/1 的含义是「未形成有效成果 / 需要重新开展」，那等于宣判这份交付无效。
 *   下这种判断必须有归属与四条件依据（谁该做、全文是否真没做、影响哪个决定），
 *   引擎没有这些依据 —— 所以把底线停在"关键工作待补"。
 */
export const DERIVATION = {
  I1: '目的状态：明示 = 4 · 推断 = 3 · 未明示 = 2',
  I2: '与 I1 同一依据；重复计分会把「目的」算两次 → 待确认',
  I3: '引擎没有「本轮 / 后续」的划分依据 → 待确认',
  S1: '引擎判不了「该选哪个」 → 待确认',
  S2: '主张同句无依据的比例：4 − round(4 × 比例)',
  S3: '引擎判不了取舍是否完成 → 待确认',
  E1: '需判缺项动作中「无责任人」的比例：4 − round(4 × 比例)',
  E2: '需判缺项动作中「无期限」的比例：4 − round(4 × 比例)',
  E3: '引擎判不了验收标准是否合理 → 待确认',
  V1: 'A4 模糊与夸大的 severity：4 − severity',
  V2: 'B4 论证层本地规则判不了 → 待确认',
  V3: 'A1/A2/A3/A5 取最高 severity：4 − severity',
}

/** 机器分钳在 2–4（理由见 DERIVATION 上方注释）。 */
const clampMachine = value => Math.max(2, Math.min(4, Math.round(value)))

/** 缺口比例 → 分。总数 0 时返回 null（没有样本就没有比例，不是"满分"）。 */
const ratioScore = (bad, total) => (total > 0 ? clampMachine(4 - (4 * bad) / total) : null)

/**
 * 从 0.3.x 已算好的证据推出十二格。
 *
 * @param {{dimensions?: object[], counted?: object, purposeStatus?: string}} input
 *   dimensions   audit 报告的 dimensions（A 维度带 severity）
 *   counted      observable.counted（主张 / 动作的计数）
 *   purposeStatus distillation.elements.purpose.status（明示 / 推断 / 未明示）
 */
export function deriveCells({ dimensions = [], counted = {}, purposeStatus = '' } = {}) {
  const list = Array.isArray(dimensions) ? dimensions : []
  const severityOf = id => {
    const found = list.find(item => item.id === id)
    if (found === undefined) return null
    if (found.state !== 'scored') return null
    return Number.isFinite(found.severity) ? found.severity : null
  }
  const severityScore = id => {
    const severity = severityOf(id)
    return severity === null ? null : clampMachine(4 - severity)
  }

  const asCount = value => (Number.isFinite(Number(value)) ? Number(value) : 0)
  const noSupport = asCount(counted.noSupport)
  const claims = asCount(counted.claims)
  const noOwner = asCount(counted.noOwner)
  const noDue = asCount(counted.noDue)
  const judgeable = asCount(counted.judgeable)

  // V3 取 A1/A2/A3/A5 里**最高的** severity，不加总：
  //   四个维度各命中一次不等于"差四倍"，最高值已经表达了"最重的那类水分"。
  const costSeverities = ['A1', 'A2', 'A3', 'A5']
    .map(severityOf)
    .filter(value => value !== null)
  const costScore = costSeverities.length === 0
    ? null
    : clampMachine(4 - Math.max(...costSeverities))

  const purposeScore = purposeStatus === '明示' ? 4 : (purposeStatus === '推断' ? 3 : 2)

  const build = (id, score) => (score === null || score === undefined
    ? { id, state: 'undetermined', source: 'machine', note: DERIVATION[id] }
    : { id, state: 'rated', score, attribution: 'undetermined', source: 'machine', note: DERIVATION[id] })

  return [
    build('I1', purposeScore),
    build('I2', null),
    build('I3', null),
    build('S1', null),
    build('S2', ratioScore(noSupport, claims)),
    build('S3', null),
    build('E1', ratioScore(noOwner, judgeable)),
    build('E2', ratioScore(noDue, judgeable)),
    build('E3', null),
    build('V1', severityScore('A4')),
    build('V2', null),
    build('V3', costScore),
  ]
}
