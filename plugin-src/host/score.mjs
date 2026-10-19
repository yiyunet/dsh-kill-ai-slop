/**
 * 双指数计算 —— 公式与六条硬约束的可执行版本。
 *
 *   指数 = 100 × Σ（适用且已评估维度的权重 × 严重度 / 4） ÷ Σ适用且已评估维度的权重
 *
 * ★ 本文件只做一件事：把"哪些维度算进分母"讲清楚。
 *   三种状态必须分开：
 *     not-applicable（不适用）→ 退出分母，写明理由
 *     insufficient（未能评估）→ 退出分母，写明为什么评不了
 *     scored（已评估）      → 进分母，severity 可以是 0（0 分代表"查过了没问题"）
 *   若把后两者混作一谈，插件就会把"我没看"报成"没问题"——这是最危险的一种假阴性。
 *
 * ★ 覆盖不足时不出总分。宁可不给结论，也不给一个让人误以为全面的数字。
 */

import { DIMENSIONS, INDICES } from './rules.mjs'

const round1 = value => Math.round(value * 10) / 10
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/** 严重度 → 人话。 */
export const SEVERITY_LABEL = {
  0: '未发现问题',
  1: '局部问题，不影响理解',
  2: '重复出现，读者需额外整理',
  3: '影响关键判断或执行',
  4: '使对应交付目标基本无法完成',
}

/** 单指数计算。 */
export function computeIndex(dimensions, indexId) {
  const members = dimensions.filter(dimension => dimension.index === indexId)
  const totalWeight = members.reduce((sum, dimension) => sum + dimension.weight, 0)
  const scored = members.filter(dimension => dimension.state === 'scored')
  const coveredWeight = scored.reduce((sum, dimension) => sum + dimension.weight, 0)

  if (coveredWeight === 0) {
    return {
      id: indexId,
      label: INDICES[indexId].label,
      value: null,
      withheld: true,
      withheldReason: `该指数下没有任何维度被成功评估（全部不适用或未能评估），按"覆盖不足不出总分"的硬约束不出分。`,
      totalWeight,
      coveredWeight: 0,
      evalCoverage: 0,
      dimensions: members.map(summarize),
    }
  }

  const numerator = scored.reduce((sum, dimension) => sum + dimension.weight * (dimension.severity / 4), 0)
  const value = round1((100 * numerator) / coveredWeight)

  return {
    id: indexId,
    label: INDICES[indexId].label,
    question: INDICES[indexId].question,
    role: INDICES[indexId].role,
    value,
    withheld: false,
    totalWeight,
    coveredWeight,
    evalCoverage: Math.round((coveredWeight / totalWeight) * 100) / 100,
    dimensions: members.map(summarize),
  }
}

function summarize(dimension) {
  return {
    id: dimension.id,
    label: dimension.label,
    weight: dimension.weight,
    state: dimension.state,
    severity: dimension.severity,
    severityLabel: dimension.state === 'scored' ? SEVERITY_LABEL[dimension.severity] : '—',
    reason: dimension.reason,
    summary: dimension.summary,
    note: dimension.note,
    hitCount: dimension.hits?.length ?? 0,
  }
}

/** 结论档位（0–100，越高问题越重）。 */
export function verdictOf(indexId, value) {
  if (value === null) return { band: '未定', text: '覆盖不足，不出结论' }
  if (indexId === 'B') {
    if (value <= 20) return { band: '可用', text: '可直接使用；只做轻度润色即可。' }
    if (value <= 40) return { band: '局部待补', text: '主体可用，缺的部分需要补上（见证据表）。' }
    if (value <= 60) return { band: '需返工', text: '接收者需要额外整理才能用；建议退回补充。' }
    if (value <= 80) return { band: '严重空转', text: '工作基本被转嫁给接收者；建议重写而不是修补。' }
    return { band: '基本不可用', text: '只作线索参考，不构成可执行的交付。' }
  }
  if (value <= 20) return { band: '干净', text: '表达成本低，几乎没有水分。' }
  if (value <= 40) return { band: '轻微水分', text: '有零星套话，不影响阅读。' }
  if (value <= 60) return { band: '中等水分', text: '套话与重复开始占阅读成本。' }
  if (value <= 80) return { band: '高水分', text: '大量篇幅在重复与铺垫，信息密度低。' }
  return { band: '几乎全是水分', text: '表达成本远超信息量。' }
}

/**
 * 可信度：给"高/中/低 + 理由"，不给假概率。
 * 依据是三类可核事实：解析覆盖率、可评估维度占比、证据条数。
 */
export function confidenceOf({ parseCoverage, evalCoverage, hitCount, chars, parseMode }) {
  const reasons = []
  let score = 3

  if (parseCoverage >= 0.95) reasons.push(`解析覆盖率 ${(parseCoverage * 100).toFixed(0)}%`)
  else {
    score -= 1
    reasons.push(`解析覆盖率仅 ${(parseCoverage * 100).toFixed(0)}%（有内容未被读取）`)
  }

  if (parseMode === 'pdf-heuristic') {
    score -= 1
    reasons.push('PDF 为启发式抽取，字体编码与分栏顺序可能失准')
  }

  // ★ 口径是"A 的覆盖"，措辞就必须说 A。
  //   原先这里印「可评估维度权重占比 100%」，紧挨着下面又说「3 项维度本地规则判不了」——
  //   读者看到的是"全覆盖"和"有三项没判"同时成立。矛盾不在数字，在**措辞暗示了一个更宽的口径**。
  //   100% 时干脆不报：没什么可披露的。
  if (evalCoverage < 0.999) {
    if (evalCoverage >= 0.8) reasons.push(`表达指数（A）可评估权重 ${(evalCoverage * 100).toFixed(0)}%`)
    else {
      score -= 1
      reasons.push(`表达指数（A）可评估权重仅 ${(evalCoverage * 100).toFixed(0)}%（部分 A 维度未能评估）`)
    }
  }

  if (hitCount >= 3) reasons.push(`命中 ${hitCount} 处可定位证据`)
  else if (hitCount === 0) {
    reasons.push('零命中（可能是干净，也可能是规则未覆盖）')
    score -= 1
  }

  if (chars < 400) {
    score -= 1
    reasons.push(`正文仅 ${chars} 字，短文本波动大`)
  }

  const level = score >= 3 ? '中' : (score >= 1 ? '低' : '很低')
  return {
    level: score >= 4 ? '高' : level,
    reasons,
  }
}

/**
 * 综合：双指数 + 覆盖判定 + 可信度。
 * @param {{dimensions: object[], docType: string, ruleSetVersion: string}} evaluation
 * @param {{parseCoverage: number, minParseCoverage?: number, minEvalCoverage?: number, parseMode?: string}} options
 */
export function computeScores(evaluation, options = {}) {
  const parseCoverage = clamp(Number(options.parseCoverage ?? 1), 0, 1)
  const minParseCoverage = Number(options.minParseCoverage ?? 0.7)
  const minEvalCoverage = Number(options.minEvalCoverage ?? 0.6)

  const indexA = computeIndex(evaluation.dimensions, 'A')
  const indexB = computeIndex(evaluation.dimensions, 'B')

  // ★ 案 A（0.2.4）：B 退出指数体系，改由「交付承接台账」承载。
  //
  // 三条理由，每一条都被实测打过：
  //   ① **判定对象错了。** B 要回答"任务有没有被接住"，这需要**两个操作数**：
  //      任务要求、实际交付。引擎从头到尾只见过交付件一个 —— 缺一个操作数，不是精度问题。
  //   ② **分母一动，分数就跳，而且跳得像能力变强。** 0.2.1 把 B4/B5 改成"未能评估"后，
  //      加权问题值一直是 27.5，分母从 85 掉到 55，分数就从 32.4 涨到 50。
  //      同一个 27.5 印成两个数，读者只会看见"变好了"。
  //   ③ 就算分母稳定，B 实际也只剩 B1+B2 在算 —— 两个词表维度合成一个 0–100 分，
  //      它长得像指标，本质是两次关键词统计。
  //
  // ⇒ B1~B6 全部保留、逐条列出，但只作**线索**，不再合成分数。
  //    正式结论看台账（slop_obligation_audit 产出的「交付承接台账」）。
  indexB.value = null
  indexB.withheld = true
  indexB.withheldReason = '工作空转不再折算为 0–100 指数 —— 它由「交付承接台账」承载。'
    + '分数表达不了"哪一条没接住、缺到什么程度"，而分母一变分数就跳，会被误读成能力变化。'
    + 'B1~B6 仍逐条列出，作为线索，不计分。'

  // ★ F39：覆盖口径**只算 A**。
  //   0.2.5 用的是 A+B 合并（A 100/100 + B 55/100 = 77.5% → 印成 78%），
  //   于是「可信度：低」被归因到一个读者无法处置的混合百分比上 ——
  //   B 早就不出分了，却还占着分母。这正是"合并口径掩盖单项缺口"的原形。
  const totalWeight = DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight, 0)
  const coveredWeight = indexA.coveredWeight
  const evalCoverage = indexA.evalCoverage

  const hitCount = evaluation.dimensions.reduce((sum, dimension) => sum + (dimension.hits?.length ?? 0), 0)
  const confidence = confidenceOf({
    parseCoverage,
    evalCoverage,
    hitCount,
    chars: evaluation.stats?.charsNoSpace ?? 0,
    parseMode: options.parseMode ?? 'exact',
  })

  // 解析覆盖不足 → 两个指数都不出分，只留局部结论
  const withholdTotal = parseCoverage < minParseCoverage
  const partial = !withholdTotal && evalCoverage < minEvalCoverage

  for (const index of [indexA, indexB]) {
    if (withholdTotal && !index.withheld) {
      index.value = null
      index.withheld = true
      index.withheldReason = `解析覆盖率 ${(parseCoverage * 100).toFixed(0)}% 低于阈值 ${(minParseCoverage * 100).toFixed(0)}%，`
        + '按"覆盖不足不出总分"的硬约束，只出局部结论、不给总分。'
    }
    if (partial && !index.withheld) {
      index.partial = true
      index.partialReason = `表达指数只覆盖了 ${(evalCoverage * 100).toFixed(0)}% 的 A 权重，分数只代表这些维度。`
    }
    index.verdict = verdictOf(index.id, index.value)
  }

  // 能出分的只剩 A。但 A **不是**主指标，它只是"唯一还被算出来的那一项"。
  // 这两句话只差几个字，读出来的意思完全相反：
  //   写成"以表达水分为主指标" → 读者把文风当质量；
  //   写成"这只是表达体检"     → 读者知道关键判断在台账里。
  const headline = indexA.value === null
    ? {
      available: false,
      text: '覆盖不足，本次不出分。',
    }
    : {
      available: true,
      index: 'A',
      value: indexA.value,
      band: indexA.verdict.band,
      text: `表达体检 ${indexA.value} / 100（${indexA.verdict.band}）。`
        + '这是表达水分，不是"这份文件能不能用"的结论 —— 关键判断在交付承接台账。',
      assistant: null,
    }

  return {
    indexA,
    indexB,
    headline,
    coverage: {
      parse: round1(parseCoverage * 100) / 100,
      evaluation: round1(evalCoverage * 100) / 100,
      // ⚠️ 这里曾写成简写 `withheldTotal` —— 变量实际叫 `withholdTotal`（无 d），
      //    于是每次调用 computeScores 都抛 ReferenceError。简写只写一次名字，看着一致，
      //    错也错得无声无息；显式 `键: 值` 让这种拼写差在阅读时就能看见。
      withheldTotal: withholdTotal,
      partial,
      minParseCoverage,
      minEvalCoverage,
    },
    confidence,
    excluded: evaluation.dimensions
      .filter(dimension => dimension.state !== 'scored')
      .map(dimension => ({
        id: dimension.id,
        label: dimension.label,
        state: dimension.state,
        reason: dimension.reason,
      })),
    ruleSetVersion: evaluation.ruleSetVersion,
  }
}
