// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/review.mjs
/**
 * 评审记录校验器（0.7.0）。
 *
 * ★ 分工：判定由通读全文的模型给，**本模块不判断"判得对不对"**。
 *   它只回答四个可以被机器确定的问题：
 *     ① 你引的这句话，原文里到底有没有、在第几行？
 *     ② 你说"这格几分"，配套的东西齐不齐（证据 / 四条件 / 待确认理由）？
 *     ③ 这份评审是不是针对**当前这一版原文**做的？
 *     ④ 算术与结论是否自洽？
 *
 * ★ 刻意不做的事：不把"条件齐全"当成"扣分有依据"。
 *   引文真、四条件都写了，只能证明**记录具备基本形式** —— 这个扣分该不该扣，
 *   仍需人/复核方看。报告因此把「分数·判定·引文·行号」印在同一行，让抽检变便宜。
 *
 * ★ 退回语义（0.7.0 修正）：
 *   扣分依据不成立时，**不是"降级但保留低分"** —— 依据没了，分就没有来源。
 *   处理是：该格撤销本次判定 → 退回待确认，并明确写"需重新判定"。
 *   但也不自动补成满分：没理由的低分和没理由的满分，是同一种撒谎。
 */

import { createHash } from 'node:crypto'

import { CELLS, CELL_ORDER, SCORE_MAX, normalizeCell, validateDeduction } from './layers.mjs'
import { verifyQuote } from './obligations.mjs'

/** 原文指纹：用于"原文变了，旧评审不许套用"。 */
export function docIdOf(text) {
  const normalized = String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .trim()
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)}`
}

const lineCount = text => String(text ?? '').split('\n').length

/**
 * 待确认格的**用户可执行引导**。
 *
 * ★ 报告是给用户看的。「归属待确认：不知该由谁完成时，不得扣分（也不得默认归提交者）」
 *   是写给维护者的规则；用户读到只会问"那我要做什么才能拿到这一格的分"。
 *   这里给的是下一步动作，不是制度解释。
 */
function guidanceOf(kind, score, reason) {
  const at = score === null || score === undefined ? '这一格原判有分' : `这一格原判 ${score} 分`
  if (kind === 'deduction-incomplete') {
    return `${at}，但没写清"这件事该由谁做、不补会卡住什么"。`
      + '补一句「这件事由我负责，不补会卡住 ___」即可按原判给分；若这本就是别人的活，这一格不扣分。'
  }
  if (kind === 'quote-not-found') {
    return `${at}，但引文在原文里找不到（八成是被改写或截断了）。`
      + '把原文那一句连标点一起原样复制过来，就能按原判给分。'
  }
  if (kind === 'no-evidence') {
    return `${at}，但没有给出任何原文依据。`
      + '补一段能说明"这一步实际做到了什么"的原文即可。'
  }
  return `${at}，依据未通过核对。${String(reason ?? '')}`
}

function normalizeEvidence(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .map(item => {
      if (typeof item === 'string') return { quote: item, line: undefined }
      if (item === null || typeof item !== 'object') return null
      return {
        quote: String(item.quote ?? ''),
        line: item.line === undefined || item.line === null ? undefined : Number(item.line),
      }
    })
    .filter(Boolean)
}

/**
 * 校验理解摘要：每条断言都必须能在原文逐字找到。
 * 找不到的那条**丢掉**（不是改写成别的），并记一条 warning —— 理解摘要不是免责声明，
 * 它得是可核的。
 */
function verifyUnderstanding(raw, docText) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const dropped = []
  const build = (key, label) => {
    const list = Array.isArray(source[key]) ? source[key] : []
    const kept = []
    for (const item of list) {
      const text = String(item?.text ?? '').trim()
      if (text === '') continue
      const evidence = []
      for (const entry of normalizeEvidence(item?.quote)) {
        const check = verifyQuote(docText, entry.quote, entry.line)
        if (check.ok) evidence.push({ quote: entry.quote, line: check.line })
      }
      if (evidence.length === 0) {
        dropped.push({ section: label, text, reason: '这一条没有任何能在原文逐字找到的引文' })
        continue
      }
      kept.push({ text, quote: evidence })
    }
    return kept
  }
  const result = {
    claims: build('claims', '提出什么'),
    done: build('done', '完成了什么'),
    open: build('open', '哪些条件未成立'),
    dropped,
  }
  result.total = result.claims.length + result.done.length + result.open.length
  return result
}

/**
 * 校验一份评审记录。
 *
 * @param {{review: object, docText: string}} input
 * @returns {{
 *   ok: boolean, code: string, message: string,
 *   docId: {claimed: string|null, actual: string, match: boolean|null},
 *   understanding: object, cells: object[],
 *   rejects: object[], warnings: object[], stats: object
 * }}
 */
export function verifyReview({ review, docText } = {}) {
  const rejects = []
  const warnings = []
  const actualDocId = docIdOf(docText)
  const lines = lineCount(docText)

  const emptyResult = (code, message, extra = {}) => ({
    ok: code === 'ok',
    code,
    message,
    docId: { claimed: null, actual: actualDocId, match: null },
    understanding: { claims: [], done: [], open: [], dropped: [], total: 0 },
    cells: CELL_ORDER.map(id => ({
      ...normalizeCell(id, { state: 'undetermined', note: message }),
      evidence: [], mergedFrom: [], claimBasis: '未知', withdrawal: null,
    })),
    rejects, warnings,
    stats: { rated: 0, rejected: 0, pending: CELL_ORDER.length, na: 0, evidenceCount: 0, lineSpread: null },
    ...extra,
  })

  if (review === null || typeof review !== 'object' || Array.isArray(review)) {
    return emptyResult('review-required', '没有收到评审记录：分数必须来自对全文的判定，引擎不代判。')
  }

  // ── ⓪ 分数刻度 ────────────────────────────────────────
  //
  // ★ 0.7.8：单格分从 0–4 改成 0–10。docId 只能证明"评的是这一版原文"，
  //   **证明不了"用的是哪一把尺"** —— 一份旧刻度的评审（3 分 = 3/4）在新刻度下
  //   会被读成 3/10，整份文件凭空掉 55 分，而且不会报任何错。
  //   所以刻度必须随评审一起记；对不上就整份拒绝，让人重新评。
  const scale = Number(review.scoreScale)
  if (scale !== SCORE_MAX) {
    return emptyResult(
      'scale-mismatch',
      `这份评审用的是 ${Number.isFinite(scale) ? `0–${scale} 分刻度` : '未标注的刻度'}，当前引擎按 0–${SCORE_MAX} 分计 —— 两个刻度混用会把同一份文件算成完全不同的分。请重新通读后提交。`,
    )
  }

  // ── ① 原文指纹 ────────────────────────────────────────
  const claimed = typeof review.docId === 'string' && review.docId !== '' ? review.docId : null
  const match = claimed === null ? null : claimed === actualDocId
  if (match === false) {
    const result = emptyResult(
      'stale-review',
      `这份评审是对另一版原文做的（评审记 ${claimed}，当前原文 ${actualDocId}）—— 旧评审不能套用到新版本。请重新通读后提交。`,
    )
    result.docId = { claimed, actual: actualDocId, match }
    return result
  }
  if (match === null) {
    warnings.push({
      kind: 'no-docid',
      message: '本次没带 docId，无法确认这份评审是针对当前这一版原文做的；原文一改，旧评审就会被误用。',
    })
  }

  // ── ② 理解摘要（P1 先述后判）────────────────────────────
  const understanding = verifyUnderstanding(review.understanding, docText)
  if (understanding.total === 0) {
    const result = emptyResult(
      'no-understanding',
      '没有可核的理解摘要：作者提出什么 / 完成了什么 / 哪些条件仍未成立，且每条都要有原文引文。'
        + '没有这一步就没有"通读"，本轮不出分。',
    )
    result.docId = { claimed, actual: actualDocId, match }
    for (const item of understanding.dropped) {
      wards(result.warnings, item)
    }
    return result
  }
  for (const item of understanding.dropped) {
    warnings.push({ kind: 'understanding-dropped', message: `理解摘要有一条未采信（${item.section}）：${item.reason} —— ${item.text.slice(0, 40)}` })
  }

  // ── ③ 十二格 ─────────────────────────────────────────
  const rawCells = Array.isArray(review.cells) ? review.cells : []
  const byId = new Map()
  for (const raw of rawCells) {
    const id = typeof raw?.id === 'string' ? raw.id.trim().toUpperCase() : ''
    if (id === '') {
      rejects.push({ cell: '—', kind: 'bad-input', reason: '有一格没有 id，无法归档' })
      continue
    }
    if (CELLS[id] === undefined) {
      rejects.push({ cell: id, kind: 'unknown-cell', reason: `没有这个检查点：${id}` })
      continue
    }
    if (byId.has(id)) {
      rejects.push({ cell: id, kind: 'duplicate', reason: '同一格重复出现，取第一条' })
      continue
    }
    byId.set(id, raw)
  }

  const quoteOwners = new Map()
  const cells = []
  for (const id of CELL_ORDER) {
    const raw = byId.get(id)
    if (raw === undefined) {
      cells.push({
        ...normalizeCell(id, { state: 'undetermined', note: '本格没有提交判定' }),
        evidence: [], mergedFrom: [], claimBasis: '未知', withdrawal: null,
      })
      continue
    }

    const base = normalizeCell(id, raw)
    const evidence = []
    const broken = []
    const corrected = []
    for (const entry of normalizeEvidence(raw.evidence)) {
      const check = verifyQuote(docText, entry.quote, entry.line)
      // ★ 三种情况必须分开，0.7.2 把它们并成两种，代价是整份评审作废：
      //   ① ok                    → 引文在、行号对
      //   ② !ok 但 check.line 有值 → **引文在，只是行号不对** → 采信，用真实行号回填，记一条提醒
      //   ③ !ok 且没有 check.line  → 原文里根本没这句话 → 这一格才退回重判
      //   实测踩过：模型报的行号系统性差 1 行，11/12 格被判"依据不成立"，
      //   而它们的引文全都真实存在。行号偏 1 是排版问题，不是造假。
      if (!check.ok && check.line === undefined) {
        broken.push(`${check.reason}${check.hint === undefined ? '' : `（${check.hint}）`}`)
        continue
      }
      if (!check.ok) {
        corrected.push({ quote: entry.quote.slice(0, 40), claimed: entry.line ?? null, actual: check.line })
      }
      evidence.push({
        quote: entry.quote,
        line: check.line,
        claimedLine: entry.line ?? null,
        moved: entry.line !== undefined && entry.line !== null && Number(entry.line) !== check.line,
      })
      const key = entry.quote.replace(/\s+/gu, '')
      const owners = quoteOwners.get(key) ?? []
      owners.push(id)
      quoteOwners.set(key, owners)
    }

    if (corrected.length > 0) {
      warnings.push({
        cell: id,
        kind: 'line-corrected',
        message: `有 ${corrected.length} 条引文行号对不上，已按原文实际位置回填：`
          + corrected.map(item => `报 L${item.claimed === null ? '—' : item.claimed} → 实为 L${item.actual}`).join('；')
          + '（引文本身存在，只是行号偏了）',
      })
    }

    const mergedFrom = Array.isArray(raw.mergedFrom)
      ? raw.mergedFrom.map(Number).filter(Number.isFinite)
      : []
    const claimBasis = ['明示', '推知', '未知'].includes(raw.claimBasis) ? raw.claimBasis : '未知'
    const withdrawal = raw.withdrawal !== null && typeof raw.withdrawal === 'object'
      ? {
        quote: String(raw.withdrawal.quote ?? ''),
        line: Number.isFinite(Number(raw.withdrawal.line)) ? Number(raw.withdrawal.line) : undefined,
        reason: String(raw.withdrawal.reason ?? ''),
      }
      : null

    const cell = { ...base, evidence, mergedFrom, claimBasis, withdrawal }

    // 退回：依据没了，分就没了来源。不降级保留，也不自动补 4。
    const reject = (kind, reason) => {
      rejects.push({ cell: id, kind, reason, claimedScore: base.state === 'rated' ? base.score : null })
      cells.push({
        ...normalizeCell(id, {
          state: 'undetermined',
          // ★ 0.7.6：这里印的是**给用户的下一步**，不是给开发者的规则说明。
          //   原先写「归属待确认：不知该由谁完成时，不得扣分」—— 用户读到只会问"那我该做什么"。
          note: guidanceOf(kind, base.score, reason),
        }),
        evidence, mergedFrom, claimBasis, withdrawal,
        rejected: { kind, reason, claimedScore: base.score },
      })
    }

    if (base.state === 'rated') {
      if (broken.length > 0) {
        reject('quote-not-found', broken.join('；'))
      } else if (evidence.length === 0) {
        reject('no-evidence', '给了分数但没有任何能在原文逐字找到的引文 —— 10 分也不例外，不能由"没命中问题"推出')
      } else if (base.score < SCORE_MAX && base.score !== null) {
        const verdict = validateDeduction(base)
        if (!verdict.ok) {
          // ★ 这里就是 0.6.0 写错的地方：以前是"降级为建议、分数不动"。
          //   依据不成立却保留低分，等于用一条站不住的缺口去压分。
          reject('deduction-incomplete', verdict.reasons.join('；'))
        } else {
          cells.push(cell)
        }
      } else {
        cells.push(cell)
      }
      continue
    }

    if (base.state === 'not-applicable' && base.note.trim() === '') {
      rejects.push({ cell: id, kind: 'na-without-reason', reason: '判"不适用"必须给理由，否则等于免检标签' })
    }
    if (base.state === 'undetermined' && base.note.trim() === '') {
      rejects.push({ cell: id, kind: 'pending-without-note', reason: '待确认必须写清"待确认什么"' })
    }
    if (broken.length > 0) {
      warnings.push({ cell: id, kind: 'quote-not-found', message: `引文未通过核对：${broken.join('；')}` })
    }
    cells.push({ ...cell, evidence })
  }

  // ── ④ 交叉检查（只提醒，不阻断）──────────────────────────
  for (const [quote, owners] of quoteOwners) {
    if (owners.length > 1) {
      warnings.push({
        kind: 'shared-evidence',
        message: `${owners.join('、')} 用了同一句原文作依据 —— 同一事实跨层扣分必须分别证明；若确有不同后果，请在 note 里写清各自后果。`,
        quote: quote.slice(0, 40),
      })
    }
  }

  const allLines = cells.flatMap(cell => cell.evidence.map(item => item.line)).filter(Number.isFinite)
  const maxLine = allLines.length === 0 ? null : Math.max(...allLines)
  const frontLoaded = maxLine !== null && lines > 20 && maxLine <= lines * 0.3
  if (frontLoaded) {
    warnings.push({
      kind: 'front-loaded',
      message: `所有引文都落在前 ${Math.round((maxLine / lines) * 100)}% 的行内（最长第 ${maxLine} 行 / 全文 ${lines} 行）—— 可能只读了开头。`
        + '这只是提醒：有些文件本来就结论前置，引文分布均匀也不证明理解正确。',
    })
  }

  const coverage = Array.isArray(review.coverage) ? review.coverage : null
  if (coverage !== null && coverage.length > 0) {
    const covered = coverage
      .map(item => [Number(item?.from), Number(item?.to)])
      .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to))
    const gaps = []
    let cursor = 1
    for (const [from, to] of covered.sort((a, b) => a[0] - b[0])) {
      if (from > cursor) gaps.push(`${cursor}–${from - 1}`)
      cursor = Math.max(cursor, to + 1)
    }
    if (cursor <= lines) gaps.push(`${cursor}–${lines}`)
    if (gaps.length > 0) {
      warnings.push({ kind: 'coverage-gap', message: `分段记录没有覆盖这些行：${gaps.join('、')} —— 未覆盖部分的理解没有依据。` })
    }
  } else {
    warnings.push({
      kind: 'no-coverage',
      message: '本次没带分段记录（coverage），无法证明长文是全文处理过的；引文只证明"读到过这些位置"。',
    })
  }

  // ★ 0.7.13：工作缺口（同一事实合并成一条）。
  //   格是**证据位置**，"还剩几件事没做"要数缺口 —— 否则同一件事进了三格，
  //   报告就会说"还差 11 处没做完"，而作者真正留下的工作只有七八项。
  const shortfalls = (Array.isArray(review.shortfalls) ? review.shortfalls : [])
    .map((item, index) => {
      if (item === null || typeof item !== 'object') return null
      const title = String(item.title ?? '').trim()
      if (title === '') return null
      const linked = Array.isArray(item.cells)
        ? item.cells.map(String).filter(id => CELLS[id] !== undefined)
        : []
      return {
        id: String(item.id ?? `SF${index + 1}`).trim() || `SF${index + 1}`,
        title,
        detail: String(item.detail ?? '').trim(),
        cells: [...new Set(linked)],
        affects: item.affects === 'direction' ? 'direction' : 'local',
        nextAction: String(item.nextAction ?? '').trim(),
        owner: typeof item.owner === 'string' ? item.owner.trim() : '',
      }
    })
    .filter(item => item !== null)

  const rated = cells.filter(cell => cell.state === 'rated')
  const na = cells.filter(cell => cell.state === 'not-applicable')
  return {
    ok: true,
    code: 'ok',
    message: '',
    docId: { claimed, actual: actualDocId, match },
    understanding,
    cells,
    shortfalls,
    rejects,
    warnings,
    stats: {
      rated: rated.length,
      rejected: cells.filter(cell => cell.rejected !== undefined).length,
      pending: cells.filter(cell => cell.state === 'undetermined').length,
      na: na.length,
      evidenceCount: allLines.length,
      lineSpread: allLines.length === 0 ? null : { min: Math.min(...allLines), max: maxLine, lines },
      frontLoaded,
    },
  }
}

/** 小工具：避免上面 early-return 分支里重复写 warnings.push。 */
function wards(target, item) {
  target.push({ kind: 'understanding-dropped', message: `${item.section}：${item.reason} —— ${String(item.text).slice(0, 40)}` })
}
