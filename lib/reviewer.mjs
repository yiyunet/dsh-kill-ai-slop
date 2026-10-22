// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/reviewer.mjs
/**
 * 面板侧评审器（0.7.2）—— 让设置面板也能走到"通读 → 判定 → 校验"这条链路。
 *
 * ★ 为什么这一层存在：
 *   v0.7 把「必须有 review」定成硬约束，但只有"模型调工具"那条路能满足它。
 *   面板是普通用户的主路径，它永远拿不到 review —— 于是永远 0/12、永远"未评"。
 *   0.7.2 接上宿主提供的 `llm` 服务，把"用户手动开一个会话"换成"面板上一个按钮"。
 *
 * ★ 这不违背 v0.7 的原则：
 *   判定仍然是**模型通读全文**给出的，不是引擎算的；引文校验照跑，核不过的格照样退回。
 *   变的只是"谁触发这一轮模型调用"。
 *
 * ★ 零依赖：不 import `@deepseek-ai/dsh-llm` 的 BlockAssembler，
 *   自己按 chunk 协议拼字（text-delta 累加、usage 记量、finish 判终态）。
 */

import { BAND_KEYS, PROTOCOL, REVIEW_SAMPLE, REVIEW_SCHEMA, rubricFull } from './rubric.mjs'
import { SCORE_MAX } from './layers.mjs'

/** 单次评审允许的最大原文长度（字符）。超过就拒绝，不截断 —— 截断会毁掉"通读全文"这个前提。 */
export const MAX_REVIEW_CHARS = 200_000

/** 系统提示：由判定规程拼成，**固定不变**，保证同一份文件两次评审问的是同一批问题。 */
export function buildSystemPrompt() {
  const rubric = rubricFull().map(item => {
    const bands = BAND_KEYS
      .filter(key => item.bands[key] !== undefined)
      .map(key => `      ${key} 分：${item.bands[key]}`)
      .join('\n')
    return [
      `### ${item.id} ${item.label}（${item.layer}）`,
      `问题：${item.question}`,
      bands,
      '      10 与 7 之间：只有这个差异会让接收者多付出一份**实际劳动**（多问一次、多算一遍、多核对一处）才往下走，否则给 10（见 P9）。',
      '      两档之间可以给 .5；不得靠 .5 或"取较高那档"逃避做判断 —— 两档都有证据时取较高档，并在 note 里写明另一档的证据是什么。',
      `证据：${item.evidence}（正面 / 缺口 / 未知三种判断各引什么，见 P8）`,
      `禁止：${item.forbidden.join('；')}`,
      `不适用说明：${item.naHint}`,
    ].join('\n')
  }).join('\n\n')

  const protocol = PROTOCOL
    .map(item => `- ${item.id} 【${item.rule}】${item.text}（理由：${item.why}）`)
    .join('\n')

  return [
    '你是文档评审员。任务：通读下面这份交付，按固定规程判断作者**已经完成了什么**、**还留下哪些必要工作**，并给出 0–10 分（0.5 一档）。',
    '',
    '## 十二条判定规程',
    rubric,
    '',
    '## 协议',
    protocol,
    '',
    '## 输出要求（违反任何一条，本次评审作废）',
    '1. 只输出**一个 JSON 对象**，不要 markdown 代码块，不要任何解释文字。**顶层必须有 `scoreScale: 10`** —— 分数刻度是 0–10，缺了整份评审作废。',
    '2. 先写 understanding（提出什么 / 完成了什么 / 哪些条件未成立），再写 cells。没有 understanding 就不得打分。',
    '3. **每一条 quote 必须逐字原样摘自原文**，包括原文里的引号本身：不得改写、不得补字、不得合并、不得用中文引号替换英文引号。行号 line 必须是物理行号。引文要**含义完整、能唯一定位**；短条款照引即可，不要为了凑长度截断或改写，也不要把编号代号（如「P2」）单独当证据。',
    '4. 每格 rated 至少一条 quote；10 分也必须给正面证据（说明"这一步实际做到了什么"），不能写"未发现问题"。',
    '5. 分数低于 10 的格，deduction 必须写全 C1–C4：C1 当前阶段为什么要做、C2 为什么是提交者的活、C3 全文合并后确实没做、C4 **不补会让接收者多付出什么实际劳动**（多问一次 / 多算一遍 / 多核对一处，或卡住某个决定）。轻微负担照实写，**不要夸大成"无法推进"**。',
    '11. **必须写 shortfalls（工作缺口）**：把"同一件事"合并成一条，哪怕它同时在几个格里扣了分。`cells` 填它影响的检查点。**不要一格一条** —— 十二格是证据位置，缺口数才是"还剩几件事没做"。',
    '6. **每格必须写 attribution**（submitter / other-party / undetermined）。**按任务、职责与阶段判断** —— 不要因为文件由某人提交，就把所有剩余工作都算在他头上。能明确指出这件事属于他人职责的填 other-party；判不出的填 undetermined（该格没有判定、不进任何分数，**不是免责**）。**漏填等于该格作废。**',
    '7. 某一格不适用时，state 写 "not-applicable" 并在 note 里说明为什么这类交付不需要它。',
    '8. 拿不准是"没写"还是"我没找到"时，state 写 "undetermined"，note 写清待确认什么、会不会挡住结论。',
    '9. 不要求每个事项都有姓名+日期+量化指标；判的是**作用有没有达成**，不是要件齐不齐。',
    '10. **原文里的引号要原样保留**（不许换成中文「」），只要求你在 JSON 里正确转义：`"` 写成 `\\"`。note、quote 里不许有真实换行或制表符（写 `\\n`、`\\t`）。一个引号没转义，整份评审就解析失败、白跑一次。',
    '',
    '## JSON 结构',
    JSON.stringify(REVIEW_SCHEMA, null, 2),
    '',
    '## JSON 样例（照这个形状填；内容只是示例，不要照抄）',
    JSON.stringify(REVIEW_SAMPLE, null, 2),
  ].join('\n')
}

/**
 * 把委托方在面板上做的两项声明写成一段话。
 *
 * ★ 0.7.11：这两项以前只留在 audit 的 0.3.x 旧维度与提炼页里，**评审模型一个字都收不到**。
 *   而判定规程好几格本来就依赖体裁（V2 说"纯记录类不承担论证义务"、E1 说"纯分析类可判不适用"），
 *   全靠模型从文本里猜。现在把"这份是什么、要拿它产出什么"明说给模型。
 */
function deliveryOf(delivery) {
  if (delivery === null || typeof delivery !== 'object') return ''
  const lines = []

  const typeLabel = typeof delivery.docTypeLabel === 'string' ? delivery.docTypeLabel.trim() : ''
  if (typeLabel !== '') {
    lines.push(delivery.docTypeSpecified === true
      ? `- 文档类型：**${typeLabel}**（委托方明确指定，以此为准，不要另判体裁）`
      : `- 文档类型：**${typeLabel}**（委托方选了"自动判断"，需要你自己从全文认定体裁，并在 note 里说清你按哪种体裁在评）`)
  }

  const levelLabel = typeof delivery.levelLabel === 'string' ? delivery.levelLabel.trim() : ''
  if (levelLabel !== '') {
    const desc = typeof delivery.levelDesc === 'string' && delivery.levelDesc.trim() !== '' ? ` —— ${delivery.levelDesc.trim()}` : ''
    lines.push(`- 期望产出：**${levelLabel}**${desc}`)
  }

  if (lines.length === 0) return ''

  return [
    '## 委托方声明',
    '',
    ...lines,
    '',
    '**这两项只影响你怎么读，不影响你用什么尺子量：**',
    '- 「文档类型」帮助你理解被评交付的内容性质（是纪要、方案还是政策），**不能替代原始任务和用途**。',
    '- 「期望产出」只控制本次体检结果最终呈现成什么样（摘要 / 卡片 / 详细），**不改变被评交付应完成的工作，也不改变评分标准**。',
    '',
    '检查点是否适用，按**任务、用途、阶段与全文内容**判断，体裁只作辅助理解。',
    '不能因为作者提交的是分析稿，就认定原任务不需要执行安排；也不能因为委托方只要卡片，就给没做完的格开脱。',
    '判 not-applicable 仍然必须给原文理由。',
    '',
  ].join('\n')
}

/** 用户消息：原文 + 任务（可选）+ 委托方声明 + 提醒首尾都读。 */
export function buildUserPrompt({ docText, task, delivery }) {
  const parts = []
  if (typeof task === 'string' && task.trim() !== '') {
    parts.push(`原始任务原话（评价基准）：\n${task.trim()}`, '')
  } else {
    parts.push('没有原始任务原话。此时 basis 填 "none"，并在 basisNote 里写明：按文件自述用途评价，只判内部一致性与可用性，不判任务承接。', '')
  }
  const declared = deliveryOf(delivery)
  if (declared !== '') parts.push(declared)
  parts.push('以下是原文全文，行号从 1 开始。开头与结尾都要读到。', '')
  // ★ 实测：模型报的行号系统性差 1 行。校验器现在会自动回填真实行号并留提醒，
  //   但源头能约束就约束 —— 行号对不上，读者去核对时会找错地方。
  parts.push('行号必须是该引文在原文中的**物理行号**：`<<<原文开始>>>` 的下一行是第 1 行，空行也算一行，不要跳过空行数。', '')
  parts.push('<<<原文开始>>>')
  parts.push(docText)
  parts.push('<<<原文结束>>>')
  parts.push('')
  parts.push('现在输出那一个 JSON 对象。')
  return parts.join('\n')
}

/** 流式拼字：按 chunk 协议累加文本，记录用量与终态。 */
export async function collectStream(stream, { onProgress } = {}) {
  let text = ''
  let usage
  let finish
  for await (const chunk of stream) {
    switch (chunk?.type) {
      case 'text-delta':
        text += String(chunk.text ?? '')
        if (typeof onProgress === 'function') onProgress(text.length)
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }
  if (finish === undefined) {
    throw Object.assign(new Error('模型流意外结束，没有收到终态'), { code: 'stream-incomplete' })
  }
  const kind = finish?.kind
  if (kind === 'error' || kind === 'aborted') {
    const failure = finish?.failure ?? {}
    throw Object.assign(
      new Error(`模型调用失败（${kind}${failure.code ? ` ${failure.code}` : ''}）：${failure.message ?? '无详细信息'}`),
      { code: kind === 'aborted' ? 'aborted' : 'llm-failed' },
    )
  }
  if (kind !== 'stop') {
    throw Object.assign(new Error(`模型以 ${kind} 结束，输出可能被截断`), { code: 'llm-truncated' })
  }
  return { text, usage, finish: kind }
}

/**
 * 修一类模型高频错误：JSON 字符串里出现**没转义的英文双引号**。
 *
 * ★ 实测症状（0.7.9）：`Expected ',' or '}' after property value in JSON at position 11793`。
 *   根因是 note 里写了 `他说"这个不行""` —— 内层引号把字符串提前闭合了，
 *   后面那半句就成了非法 token。模型明明读懂了文件，却卡在一个引号上重跑一次，
 *   代价是 30–90 秒和一次完整的 token。
 *
 * 判据（启发式）：字符串里的 `"`，若其后第一个非空白字符是 , } ] : 之一，才算字符串结束；
 * 否则它就是内容，转义掉。顺带把字符串里的真实换行/制表符转义（否则报 Bad control character）。
 *
 * 只在首次 parse 失败后才用 —— 正常输出一个字都不改。
 */
export function repairUnescapedQuotes(text) {
  const punctuation = new Set([',', '}', ']', ':'])
  let out = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]

    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }

    if (ch === '"') {
      if (!inString) {
        inString = true
        out += ch
        continue
      }
      let lookahead = index + 1
      while (lookahead < text.length && /\s/u.test(text[lookahead])) lookahead += 1
      const next = text[lookahead]
      const closes = next === undefined || punctuation.has(next)
      if (closes) {
        inString = false
        out += ch
      } else {
        out += '\\"'
      }
      continue
    }

    if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : (ch === '\r' ? '\\r' : '\\t')
      continue
    }

    out += ch
  }

  return out
}

/**
 * 从模型输出里取出那一个 JSON 对象。
 * 容忍 ```json 围栏与前后废话 —— 但**不容忍**重复成员或非对象。
 */
export function extractReviewJson(raw) {
  const source = String(raw ?? '').trim()
  if (source === '') throw Object.assign(new Error('模型返回空内容'), { code: 'empty-output' })

  let body = source
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(source)
  if (fenced !== null) body = fenced[1].trim()

  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) {
    // ★ 模型返回数组是真实会发生的跑偏，别笼统说"没找到 JSON" ——
    //   读者手里明明有一段合法 JSON，报"没有 JSON"只会让人去查错地方。
    if (body.indexOf('[') >= 0) {
      throw Object.assign(new Error('模型输出的不是一个 JSON 对象（返回的是数组）'), {
        code: 'bad-json',
        details: { head: body.slice(0, 300) },
      })
    }
    throw Object.assign(new Error('模型输出里没有找到 JSON 对象'), { code: 'no-json', details: { head: source.slice(0, 200) } })
  }
  const candidate = body.slice(start, end + 1)

  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch (first) {
    // 二次尝试：修掉没转义的引号 / 字符串里的真实换行，再 parse 一次。
    try {
      parsed = JSON.parse(repairUnescapedQuotes(candidate))
    } catch {
      const position = Number((/at position (\d+)/u.exec(first.message) ?? [])[1])
      const around = Number.isFinite(position) && position >= 0
        ? candidate.slice(Math.max(0, position - 90), position + 90)
        : ''
      throw Object.assign(
        new Error(`模型输出的 JSON 不合法：${first.message}${around === '' ? '' : `\n出错位置附近：…${around}…`}`),
        {
          code: 'bad-json',
          details: { head: candidate.slice(0, 300), around, position: Number.isFinite(position) ? position : null },
        },
      )
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('模型输出的不是一个 JSON 对象'), { code: 'bad-json' })
  }
  return parsed
}

/**
 * 走一次模型调用，拿回 review 对象。
 * @param {{llm: object, docText: string, task?: string, provider: string, model: string, signal?: AbortSignal, onProgress?: Function}} input
 */
export async function generateReview(input) {
  const { llm, docText, task, delivery, provider, model, signal, onProgress } = input
  if (typeof docText !== 'string' || docText.trim() === '') {
    throw Object.assign(new Error('原文为空，无法评审'), { code: 'bad-request' })
  }
  if ([...docText].length > MAX_REVIEW_CHARS) {
    throw Object.assign(
      new Error(`原文 ${[...docText].length} 字，超过单次评审上限 ${MAX_REVIEW_CHARS} 字。截断评审会毁掉"通读全文"这个前提，所以这里直接拒绝。`),
      { code: 'doc-too-long', details: { maxReviewChars: MAX_REVIEW_CHARS } },
    )
  }
  if (typeof llm?.stream !== 'function') {
    throw Object.assign(new Error('宿主未提供 llm 服务，面板无法生成评审'), { code: 'llm-unavailable' })
  }

  const options = {
    provider,
    model,
    system: buildSystemPrompt(),
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: buildUserPrompt({ docText, task, delivery }) }],
    }],
    temperature: 0,
    ...(signal === undefined ? {} : { signal }),
  }

  const { text, usage } = await collectStream(llm.stream(options), { onProgress })
  const review = extractReviewJson(text)
  // ★ 0.7.8：刻度由**引擎**在这条路径上定死（提示词里只允许 0–10），
  //   所以这里回填 `scoreScale` 是登记"用的是哪把尺"，不是替模型作证。
  //   外部提交的 review 不走这条路径，缺刻度照样整份作废。
  if (review !== null && typeof review === 'object' && !Array.isArray(review)) {
    review.scoreScale = SCORE_MAX
  }
  return { review, raw: text, usage }
}

/** 列出可用 provider/model。同步/异步都兼容（平台里 listProviders 是同步的）。 */
export async function listReviewModels(llm) {
  const settle = async value => (value !== null && typeof value?.then === 'function' ? await value : value)
  if (typeof llm?.listProviders !== 'function') return []
  const providers = await settle(llm.listProviders())
  const out = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = String(provider?.id ?? '')
    if (id === '') continue
    let models = []
    try {
      const listed = await settle(llm.listModels(id))
      models = (Array.isArray(listed) ? listed : []).map(item => ({ id: String(item?.id ?? ''), name: String(item?.name ?? item?.id ?? '') })).filter(item => item.id !== '')
    } catch {
      models = []
    }
    out.push({ id, name: String(provider?.name ?? id), models })
  }
  return out
}
