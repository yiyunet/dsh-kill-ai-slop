// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/index.mjs
/**
 * dsh-kill-ai-slop —— 插件入口（宿主半侧，唯一真源）。
 *
 * 能力：对收到的文件做**表达体检**（A 表达水分分）＋ **交付承接台账**（B，需任务原话＋义务表）＋ **五要素保真提炼**。
 * 全部计算在本进程内完成：不联网、不上传、不落盘（除非显式配置 reportRoot）。
 *
 * ⚠️ 本文件只 import `@deepseek-ai/dsh-tools`（由 Host 运行时提供）。
 *    绝不可把它写进 package.json 的任何依赖节 —— DSH 运行时包用模块局部 Symbol 做 key，
 *    装第二份物理副本会破坏 Host 查找。
 *
 * ⚠️ 安全边界（刻意收紧，不改默认值）：
 *    工具 `slop_audit_file` 能读**宿主进程**的文件系统，这比 agent 自己的读写沙箱更大。
 *    因此默认 `inputRoots: []` = 不开放；要开放必须显式配置允许目录，且路径必须落在其中。
 *    "上传文件"这条主路径走的是面板 RPC（用户自己选文件），不经过本工具，因此默认值不影响主用途。
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { ENGINE_VERSION, audit, renderAuditMarkdown } from './audit.mjs'
import { distill, renderDistillMarkdown } from './distill.mjs'
import { auditObligations, renderObligationMarkdown, verifyQuote } from './obligations.mjs'
import { parseFile } from './parse.mjs'
import { DOC_TYPES, RULESET_ENGINE, RULESET_VERSION } from './rules.mjs'
import { registerSlopRpc } from './rpc.mjs'

export const name = 'kill-ai-slop'
export const inject = ['tools']

const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

const json = payload => JSON.stringify(payload, null, 2)

/**
 * 把工具参数里的义务表（JSON 字符串 / 数组 / {obligations:[]} 包装）统一成数组。
 * 不合契约就让调用方失败 —— **不接受"看起来像义务表"的东西**。
 * 这一层故意做得很窄：它只保证"形状对"，不保证"义务拆得对"。
 * 拆得对不对是语义问题，插件管不了，管了就是假装。
 */
function parseObligationsArg(raw) {
  if (raw === undefined || raw === null) return undefined
  if (Array.isArray(raw)) return raw
  const text = String(raw).trim()
  if (text === '') return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw Object.assign(new Error(`obligations 不是合法 JSON：${error.message}`), {
      code: 'BAD_JSON',
      hint: '传 JSON 数组字符串，例如 [{"id":"O1","question":"…","coverage":"missing","evidence":[]}]。',
    })
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.obligations
  if (!Array.isArray(list)) {
    throw Object.assign(new Error('obligations 必须是数组，或用 {"obligations": [...]} 包装。'), {
      code: 'BAD_INPUT',
    })
  }
  return list
}

function fail(error) {
  return json({
    ok: false,
    error: String(error?.message ?? error),
    ...(error?.code === undefined ? {} : { code: error.code }),
    ...(error?.hint === undefined ? {} : { hint: error.hint }),
    ...(error?.stage === undefined ? {} : { stage: error.stage }),
  })
}

/** 内存里的"最近报告"环形缓冲（不写盘）。 */
function createRecent(limit) {
  const items = []
  // 摘要与完整报告并行保存：列表只传摘要（轻），点击时才按序号取回完整报告。
  // 之前只存摘要，于是"最近报告"能看不能点 —— 列表成了摆设。
  const reports = []
  return {
    push(report) {
      items.unshift({
        at: new Date().toISOString(),
        filename: report.filename,
        docType: report.docType.label,
        slop: report.observable?.slopScore ?? null,
        indexB: report.scores.indexB.value,
        indexA: report.scores.indexA.value,
        withheld: report.scores.indexB.withheld,
        confidence: report.scores.confidence.level,
        chars: report.file.chars,
      })
      reports.unshift(report)
      while (items.length > limit) { items.pop(); reports.pop() }
    },
    list() {
      return items.slice()
    },
    get(index) {
      const at = Number(index)
      if (!Number.isInteger(at) || at < 0 || at >= reports.length) return undefined
      return reports[at]
    },
  }
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const recent = createRecent(Number(config.keepRecent ?? 20))

  /**
   * 把路径限制在允许的根目录内。
   * 未配置 inputRoots ⇒ 一律拒绝（默认不开放宿主文件读取）。
   */
  function resolveInputPath(rawPath) {
    const roots = Array.isArray(config.inputRoots)
      ? config.inputRoots.filter(item => typeof item === 'string' && item.trim() !== '').map(item => resolve(item))
      : []
    if (roots.length === 0) {
      const error = new Error('本插件默认不开放宿主文件读取（inputRoots 为空）。')
      error.code = 'INPUT_ROOT_NOT_CONFIGURED'
      error.hint = '在 profile 的 cordis.patch.yml 里为 kill-ai-slop 设 inputRoots: [<目录>] 后重启 Host；'
        + '或改用设置面板上传文件（面板路径不需要开这个开关）。'
      throw error
    }
    const target = resolve(String(rawPath))
    for (const root of roots) {
      const rel = relative(root, target)
      if (!rel.startsWith('..') && !isAbsolute(rel)) return target
    }
    const error = new Error(`路径不在允许的 inputRoots 内：${target}`)
    error.code = 'PATH_OUTSIDE_INPUT_ROOTS'
    error.hint = `当前允许：${roots.join('、')}`
    throw error
  }

  // ── ① 引擎自检 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'slop_engine_info',
    description: '「AI垃圾过滤 / Kill AI Slop」引擎自检：返回引擎版本、规则集版本、支持的文件格式、'
      + '各维度权重、文档类型清单、隐私与门禁开关的当前取值。'
      + '排查"为什么这个文件分析不了"时先跑它 —— 能直接看出是文件类型不支持、还是 inputRoots 没配。',
    parameters: {},
    output: textOutput,
    async execute() {
      return json({
        ok: true,
        plugin: '@yiyunet/dsh-kill-ai-slop',
        displayName: { zh: 'AI垃圾过滤', en: 'Kill AI Slop' },
        engineVersion: ENGINE_VERSION,
        ruleSetVersion: RULESET_VERSION,
        supported: ['txt', 'md', 'csv', 'json', 'log', 'yaml', 'html', 'rtf', 'docx', 'pptx', 'xlsx', 'pdf'],
        notSupported: ['doc', 'xls', 'ppt', 'ZIP/RAR 压缩包', '图片（无 OCR）', 'eml/msg'],
        docTypes: DOC_TYPES,
        gates: {
          inputRoots: Array.isArray(config.inputRoots) ? config.inputRoots : [],
          maxFileBytes: Number(config.maxFileBytes ?? 20 * 1024 * 1024),
          maxChars: Number(config.maxChars ?? 600000),
          includeSnippets: config.includeSnippets !== false,
          reportRoot: typeof config.reportRoot === 'string' ? config.reportRoot : '',
        },
        weightsAreProvisional: '维度权重与阈值当前为初案（未经校准），不是已验证标准；规则集变更即换版本号。',
        tools: [
          'slop_engine_info（本工具）',
          'slop_audit_text（文本体检：A 表达指数 + 交付承接台账 + 结构检查）',
          'slop_audit_file（文件体检，需 inputRoots）',
          'slop_distill（五要素保真提炼）',
          'slop_obligation_audit（交付承接台账：义务逐条记账 + 引文复核）',
          'slop_verify_quotes（只做引文复核）',
        ],
        capabilityBoundary: {
          ruleEngineCanJudge: ['结构（标题/列表/层级）', '显式数值口径（同指标不同值/合计与分项/时限先后）', '词表类表达特征', '字段与证据定位', '引文是否真实存在于原文', '同一句里有没有出处标记'],
          ruleEngineCannotJudge: [
            'B3 论据支撑：只能判"同句有没有依据标记"，判不了"这个依据是否支撑这个结论" —— 补一句"根据上述调查"就能满足规则，推论跨越照样存在',
            'B4 逻辑一致性：推论跨越、对象外推、优先级前后不一致 —— 规则只能核对数值，文字论证判不了',
            'B5 决策支持：识别到风险之后方案有没有改 —— 需要判因果',
            '任务承接：必须有原始任务作基准，单看一份文档算不出"缺口"',
            '义务拆解：本插件不拆义务。从文档倒推出来的义务表本质是最佳实践清单，会把任务缺口洗成"已满足"',
          ],
          policy: '能判不了的维度一律返回 insufficient（未能评估），不再返回 0 分。'
            + '把"我没看"印成"没问题"，是最危险的一种假阴性。'
            + 'B 整体已退出指数体系（0.2.4）：这不是"判得更准"，而是**不再假装能算**。',
        },
        observedFacts: {
          what: '能数出来的事实：动作项条数、无责任人条数、无期限条数、主张无依据标记条数、目的陈述位置。',
          state: 'observed（已观测）—— 数出来了，但不据以下判，也不进任何分数。',
          why: '「判不了」不等于「什么都不能说」。这四项既不需要任务基准、也不需要语义理解，只需要数；'
            + '而它们恰好是「把决策与执行转嫁给接收者」的可观测骨架。'
            + '把它们一并说成"没判"，等于主动扔掉本工具唯一 100% 可靠的那部分信号。',
        },
        moduleConsistency: {
          ok: RULESET_ENGINE === ENGINE_VERSION,
          engine: ENGINE_VERSION,
          rulesEngine: RULESET_ENGINE ?? '(缺失：rules.mjs 为旧版本)',
          note: '不一致 = 热重载残留（只重载了部分文件），此时体检会拒绝出分；重启 DSH 即可恢复。',
        },
        privacy: '零联网、零上传、默认零落盘。所有计算在本机 Host 进程内完成。',
        disclaimer: '判的是"这份文件能不能用"，不鉴定作者、不用于员工评价。',
        reportEndpoint: Array.isArray(config.inputRoots) && config.inputRoots.length > 0
          ? '已开放宿主文件读取（受 inputRoots 限制）'
          : '未开放宿主文件读取 —— 请用设置面板上传，或配置 inputRoots',
      })
    },
  }))

  // ── ② 体检（文本）──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'slop_audit_text',
    description: '对一段文本做「AI垃圾过滤」体检：给出表达指数（A 表达水分）、'
      + '逐维证据（原文片段 + 为什么 + 怎么改）、覆盖判定与可信度，并附五要素提炼。'
      + '**工作空转（B）不出指数** —— 它要回答"任务有没有被接住"，必须由你传入任务原话（task）'
      + '和你拆出的义务表（obligations），报告会把承接结论放在第一节并附逐条台账。'
      + '判的是"这份文件能不能用"，不鉴定作者。'
      + '⚠️ 零命中不等于干净；解析覆盖不足时不会给总分（会明示）。',
    parameters: {
      text: { type: 'string', required: true, description: '要分析的文本（原始内容，不要预先总结）' },
      docType: {
        type: 'string',
        description: '文档类型：auto（默认，自动判断）/ proposal / plan / report / minutes / research / explainer / notice / generic。'
          + '类型是适用性开关 —— 纪要没有论证链不算缺陷。',
      },
      level: { type: 'string', description: '提炼档位：integrity（保真精简）/ summary（默认）/ card（速读卡片）' },
      task: {
        type: 'string',
        description: '原始任务原话。给了才会做「交付承接」评价；不给则报告明确写"没有承接结论"——'
          + '因为"有没有把任务接住"必须有任务作另一个操作数。',
      },
      obligations: {
        type: 'string',
        description: '义务表 JSON 数组（或 {"obligations":[...]} 包装），由你按任务拆出。'
          + '本插件**不自己拆义务** —— 从文档倒推的义务表＝最佳实践清单，会把任务缺口洗成"已满足"。'
          + '字段同 slop_obligation_audit。',
      },
      format: { type: 'string', description: 'markdown（默认，出完整报告）/ json（只要结构化数据）' },
    },
    output: textOutput,
    async execute(args) {
      try {
        if (typeof args.text !== 'string' || args.text.trim() === '') {
          throw Object.assign(new Error('text 不能为空'), { code: 'BAD_INPUT' })
        }
        const report = audit({
          buffer: Buffer.from(args.text, 'utf8'),
          filename: '文本输入.txt',
          docType: args.docType ?? 'auto',
          level: args.level ?? 'summary',
          task: args.task,
          obligations: parseObligationsArg(args.obligations),
          source: 'tool-text',
          config,
        })
        recent.push(report)
        if (args.format === 'json') {
          const { markdown, ...rest } = report
          return json(rest)
        }
        return report.markdown
      } catch (error) {
        return fail(error)
      }
    },
  }))

  // ── ③ 体检（文件）──────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'slop_audit_file',
    description: '对宿主上的一个文件做「AI垃圾过滤」体检（docx / pptx / xlsx / pdf / txt / md / csv / json / html）。'
      + '⚠️ 默认**关闭**：必须在 profile 里配置 inputRoots 才会放行，且路径须落在其中。'
      + '日常"用户上传文件"请用设置面板（不需要开这个开关）。'
      + '解析覆盖不足时不会给总分，并会在报告里写明为什么。',
    parameters: {
      path: { type: 'string', required: true, description: '文件绝对路径（须在配置的 inputRoots 内）' },
      docType: { type: 'string', description: '文档类型：auto（默认）/ proposal / plan / report / minutes / research / explainer / notice / generic' },
      level: { type: 'string', description: '提炼档位：integrity / summary（默认）/ card' },
      task: {
        type: 'string',
        description: '原始任务原话。给了才会做「交付承接」评价；不给则报告明确写"没有承接结论"。',
      },
      obligations: {
        type: 'string',
        description: '义务表 JSON 数组（或 {"obligations":[...]} 包装），由你按任务拆出。本插件不自己拆义务。',
      },
      format: { type: 'string', description: 'markdown（默认）/ json' },
    },
    output: textOutput,
    async execute(args) {
      try {
        const target = resolveInputPath(args.path)
        const buffer = await readFile(target)
        const report = audit({
          buffer,
          filename: target.split(/[\\/]/u).pop() ?? target,
          docType: args.docType ?? 'auto',
          level: args.level ?? 'summary',
          task: args.task,
          obligations: parseObligationsArg(args.obligations),
          source: 'tool-file',
          config,
        })
        recent.push(report)
        if (args.format === 'json') {
          const { markdown, ...rest } = report
          return json(rest)
        }
        return report.markdown
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return fail(Object.assign(new Error(`文件不存在：${args.path}`), { code: 'ENOENT' }))
        }
        return fail(error)
      }
    },
  }))

  // ── ④ 只做提炼 ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'slop_distill',
    description: '只做五要素提炼（不评分）：目的 / 阐述 / 观点 / 态度 / 执行 ＋ 证据与限制 ＋ 必须追问。'
      + '**抽取式，不改写**：每一句都是原文片段，可回原文逐字核对；'
      + '数字、日期、责任人、承诺、条件结论等保护项强制保留，任何档位都不会丢。'
      + '适合已经知道文件质量、只想快速拿到"它到底说了什么"的场景。',
    parameters: {
      text: { type: 'string', required: true, description: '要提炼的原文（不要预先总结 —— 提炼必须基于原文）' },
      level: { type: 'string', description: 'integrity / summary（默认）/ card' },
      format: { type: 'string', description: 'markdown（默认）/ json' },
    },
    output: textOutput,
    async execute(args) {
      try {
        if (typeof args.text !== 'string' || args.text.trim() === '') {
          throw Object.assign(new Error('text 不能为空'), { code: 'BAD_INPUT' })
        }
        const result = distill(args.text, { level: args.level ?? 'summary' })
        if (args.format === 'json') {
          const { text, sentences, ...rest } = result
          return json(rest)
        }
        return renderDistillMarkdown({ ...result, levelDesc: '' })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  // ── ⑤ 交付承接台账 ─────────────────────────────────────────────────────
  //
  // 案 A 的分工：语义判断由具备该能力的一方（宿主 agent / 模型）完成并交进来，
  // **本插件只做校验与汇总**。它从不判断"这个结论对不对"，只判断"这条引文在不在原文"。
  // 之所以这样切：模型最容易骗人的地方正是编行号和编引文，而规则层在这件事上 100% 可靠。
  async function loadDocText(args) {
    if (typeof args.text === 'string' && args.text.trim() !== '') {
      return { docText: args.text, sourceMode: 'raw-text' }
    }
    if (typeof args.path === 'string' && args.path.trim() !== '') {
      const target = resolveInputPath(args.path)
      const buffer = await readFile(target)
      const parsed = parseFile(
        { buffer, filename: target.split(/[\\/]/u).pop() ?? target },
        { maxChars: Number(config.maxChars ?? 600000) },
      )
      return { docText: parsed.text, sourceMode: `parsed-file:${parsed.format}` }
    }
    throw Object.assign(new Error('必须提供 text 或 path 之一（台账要拿原文逐字复核引文）'), { code: 'BAD_INPUT' })
  }

  ctx.tools.register(defineTool({
    name: 'slop_obligation_audit',
    description: '「交付承接台账」：对一份「义务表 + 原文」做本地校验与汇总。'
      + '义务表由**你（评审方）**给出 —— 任务要求交的每件事算一条，逐条判 met/partial/missing/conflicting 并附原文引文；'
      + '本工具负责：①逐条复核引文是否真的在原文、行号对不对；②状态是否自洽（说"已满足"却拿不出引文=违规）；'
      + '③结论是否越权（无任务基准时不许说"满足交付要求"）；④同根因去重；⑤汇总台账与首页判断。'
      + '⚠️ 本工具不判断结论对错，只判断证据有没有。引文对不上，判定一律降级为不可采信。',
    parameters: {
      obligations: {
        type: 'string',
        required: true,
        description: 'JSON 数组（或 {"obligations": [...]} 包装）。每项：id / question（这条义务要回答什么）/ '
          + 'origin（explicit|essential|optional）/ critical（bool）/ coverage（met|partial|missing|conflicting）/ '
          + 'evidence（[{quote, line}]，quote 至少 4 个有效字符，不要用 "P2" 这类代号）/ '
          + 'finding / impact / repair / resolutionTest。',
      },
      task: { type: 'string', description: '原始任务原话。**强烈建议给** —— 没有它就没有基准，"任务承接"无从判断。' },
      text: { type: 'string', description: '原文全文（用于逐字复核引文）。与 path 二选一。' },
      path: { type: 'string', description: '原文文件路径（须在配置的 inputRoots 内）。与 text 二选一。' },
      basis: { type: 'string', description: '基准来源：task（有任务原话）/ self-stated（按文档自述目标）/ none（无基准，只列清单）' },
      format: { type: 'string', description: 'markdown（默认）/ json' },
    },
    output: textOutput,
    async execute(args) {
      try {
        let parsed
        try {
          parsed = JSON.parse(args.obligations)
        } catch (error) {
          throw Object.assign(new Error(`obligations 不是合法 JSON：${error.message}`), {
            code: 'BAD_JSON',
            hint: '传 JSON 数组字符串，例如 [{"id":"O1","question":"…","coverage":"missing","evidence":[]}]。',
          })
        }
        const loaded = await loadDocText(args)
        const report = auditObligations({
          docText: loaded.docText,
          task: args.task,
          basis: args.basis,
          obligations: Array.isArray(parsed) ? parsed : parsed.obligations,
          sourceMode: loaded.sourceMode,
        })
        if (args.format === 'json') {
          const { markdown, ...rest } = report
          return json(rest)
        }
        return report.markdown
      } catch (error) {
        return fail(error)
      }
    },
  }))

  // ── ⑥ 引文复核（可单独用）──────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'slop_verify_quotes',
    description: '引文复核：给定若干条引文，逐条回答"原文里到底有没有这句话、在第几行"。'
      + '写任何带证据的评审之前先用它自查 —— 行号错了、引文编了，读者去错的地方核对，整份报告的信任就没了。',
    parameters: {
      quotes: { type: 'string', required: true, description: 'JSON 数组，元素为字符串或 {"quote": "...", "line": 123}' },
      text: { type: 'string', description: '原文全文。与 path 二选一。' },
      path: { type: 'string', description: '原文文件路径（须在 inputRoots 内）。与 text 二选一。' },
    },
    output: textOutput,
    async execute(args) {
      try {
        let list
        try {
          list = JSON.parse(args.quotes)
        } catch (error) {
          throw Object.assign(new Error(`quotes 不是合法 JSON：${error.message}`), { code: 'BAD_JSON' })
        }
        if (!Array.isArray(list)) throw Object.assign(new Error('quotes 必须是 JSON 数组'), { code: 'BAD_INPUT' })
        const loaded = await loadDocText(args)
        const results = list.map(item => {
          const isPlain = typeof item === 'string'
          const quote = isPlain ? item : String(item?.quote ?? '')
          const claimedLine = isPlain ? undefined : item?.line
          const check = verifyQuote(loaded.docText, quote, claimedLine)
          return { quote, claimedLine: claimedLine ?? null, ...check }
        })
        return json({
          ok: true,
          total: results.length,
          passed: results.filter(item => item.ok).length,
          results,
        })
      } catch (error) {
        return fail(error)
      }
    },
  }))

  // 设置面板的 RPC 端点。
  //
  // ★ 必须 scoped 注入，不能写进顶层 inject：
  //   `connection` 只存在于 web 平面。写进 inject = ['tools','connection'] 会让本插件在
  //   headless / tui profile 里永远停在 inactive —— 连 4 个 slop_* 工具一起消失。
  //   ctx.inject(['connection'], cb) 是"可选依赖"语义：有服务就执行，没有就静默跳过。
  let rpcState = { registered: false, reason: '等待 connection 服务（仅 web 平面存在）' }
  ctx.inject(['connection'], rpcCtx => {
    const disposeRpc = registerSlopRpc(rpcCtx, { config, logger: ctx.logger, recent })
    rpcState = typeof disposeRpc === 'function'
      ? { registered: true, reason: 'ok', endpoint: '/api/dsh-kill-ai-slop' }
      : { registered: false, reason: 'connection.fetch.register 不可用' }
    rpcCtx.effect(function* () {
      yield () => { if (typeof disposeRpc === 'function') disposeRpc() }
    }, 'kill-ai-slop rpc endpoint')
  })

  ctx.logger?.info?.('[kill-ai-slop] 已注册 6 个工具（slop_engine_info / slop_audit_text / slop_audit_file / slop_distill'
    + ' / slop_obligation_audit / slop_verify_quotes）'
    + `；inputRoots=${Array.isArray(config.inputRoots) && config.inputRoots.length > 0 ? '已配置' : '未配置（宿主文件读取关闭）'}`
    + `；includeSnippets=${config.includeSnippets !== false}`)
}

export {
  audit, distill, renderAuditMarkdown, renderDistillMarkdown,
  auditObligations, renderObligationMarkdown, verifyQuote,
  ENGINE_VERSION, RULESET_VERSION,
}
