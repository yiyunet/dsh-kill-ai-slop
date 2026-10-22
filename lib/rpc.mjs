// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。
// 真源：plugin-src/host/rpc.mjs
/**
 * 客户端 ↔ 宿主 RPC —— 设置面板通过它做上传、体检、保存。
 *
 * ★ 响应信封形状是硬性的（已实测；改了会静默失效）：
 *     成功 → { type:'server-response', rpcId, result:{ ok:true, value:<载荷> } }
 *     失败 → { type:'server-response', rpcId, result:{ ok:false, error:{ code, message, details:{…} } } }
 *   把载荷直接摊在 result 上（而不是 result.value）会导致面板渲染出一片空壳，
 *   而 RPC 本身**不报错** —— 这类静默失效最难查，故形状写死在这里，只有一个出口 `reply()`。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { ENGINE_VERSION, audit } from './audit.mjs'
import { CELL_DISPLAY_ORDER, CELL_ORDER, DISPLAY_ORDER, LAYERS, SCORE_ANCHORS } from './layers.mjs'
import { DOC_TYPES, RULESET_VERSION } from './rules.mjs'
import { LEVELS } from './distill.mjs'
import { parseFile } from './parse.mjs'
import { docIdOf } from './review.mjs'
import { MAX_REVIEW_CHARS, generateReview, listReviewModels } from './reviewer.mjs'

/** 端点名（不含 /api/ 前缀）。客户端必须用同一个名字。 */
export const RPC_ENDPOINT = 'dsh-kill-ai-slop'

const SUPPORTED = [
  'txt', 'md', 'csv', 'json', 'log', 'yaml', 'html', 'rtf',
  'docx', 'pptx', 'xlsx', 'pdf',
]

function reply(rpcId, result) {
  if (result?.ok === false) {
    const error = result.error ?? {}
    return Response.json({
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: {
          code: String(error.code ?? 'failed'),
          message: String(error.message ?? '未知错误'),
          // details 必须是对象；缺了会被客户端判为非法响应
          details: (error.details !== null && typeof error.details === 'object') ? error.details : {},
        },
      },
    })
  }
  return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: result } })
}

/**
 * 注册 RPC 端点。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{config: object, logger: object, recent: object}} deps
 */
export function registerSlopRpc(ctx, deps) {
  const { config = {}, recent, getLlm } = deps

  // ★ llm 是**可选**依赖：headless / 未配置模型的 profile 里没有它。
  //   取用要放到每次请求时（不是在注册时），否则先注册后加载 llm 的时序会让面板一直报"不可用"。
  const llmOf = () => (typeof getLlm === 'function' ? getLlm() : undefined)

  /**
   * 评审任务表：面板点一次「生成评审」= 一次后台任务。
   *
   * ★ 为什么不在一个请求里做完：一次评审要 30–90 秒，长请求会撞上超时，
   *   而且面板拿不到任何进度。拆成「启动 / 轮询 / 取消」三段后，
   *   面板可以显示"已生成 N 字"，用户也能取消。
   */
  const jobs = new Map()
  const JOB_LIMIT = 8
  const rememberJob = job => {
    jobs.set(job.id, job)
    while (jobs.size > JOB_LIMIT) jobs.delete(jobs.keys().next().value)
  }

  if (typeof ctx?.connection?.fetch?.register !== 'function') {
    deps.logger?.warn?.('[kill-ai-slop] 宿主未提供 connection.fetch.register —— 设置面板不可用（工具不受影响）')
    return undefined
  }

  const methods = {
    /** 面板加载时调用：引擎版本、支持格式、上限、隐私开关。 */
    async status() {
      return {
        ok: true,
        engineVersion: ENGINE_VERSION,
        ruleSetVersion: RULESET_VERSION,
        supported: SUPPORTED,
        docTypes: DOC_TYPES,
        levels: LEVELS,
        // 四层十二格的定义 —— 面板据此渲染填写界面，不再硬编码格子名。
        layers: {
          version: 'layers/0.6.0',
          direction: 'higher-is-better',
          weights: Object.fromEntries(DISPLAY_ORDER.map(id => [id, LAYERS[id].weight])),
          weightsCalibrated: false,
          anchors: SCORE_ANCHORS,
          // ★ 显示顺序由**宿主**给出（表达→策略→执行→意图），面板不再自己写一份。
          //   两处各写一份时，报告与面板会排出两个顺序 —— 同一份结果两个说法。
          displayOrder: DISPLAY_ORDER,
          definitions: DISPLAY_ORDER.map(id => ({
            id,
            label: LAYERS[id].label,
            question: LAYERS[id].question,
            slopPattern: LAYERS[id].slopPattern,
            cells: LAYERS[id].cells,
          })),
          cellOrder: CELL_ORDER,
          cellDisplayOrder: CELL_DISPLAY_ORDER,
        },
        limits: {
          maxFileBytes: Number(config.maxFileBytes ?? 20 * 1024 * 1024),
          maxRpcBytes: Number(config.maxRpcBytes ?? 12 * 1024 * 1024),
          maxChars: Number(config.maxChars ?? 600000),
        },
        privacy: {
          includeSnippets: config.includeSnippets !== false,
          reportRoot: typeof config.reportRoot === 'string' ? config.reportRoot : '',
        },
        // 面板据此决定「生成评审」按钮是可用还是给说明。
        // ★ 注意：这里只说**有没有 llm 服务**，不代表已经配了可用模型 ——
        //   模型清单由 models() 单独给，避免面板每次刷新都去枚举 provider。
        llm: { available: typeof llmOf()?.stream === 'function' },
        disclaimer: '判的是文件能不能用，不鉴定作者、不评人。零联网、零上传：所有计算在本机 Host 进程内完成。',
      }
    },

    /**
     * 可用模型清单。面板用它渲染下拉；没有 llm 服务时返回 available:false，
     * 面板据此把「生成评审」按钮变成说明文字，而不是点了报错。
     */
    async models() {
      const llm = llmOf()
      if (typeof llm?.stream !== 'function') {
        return {
          ok: true,
          available: false,
          providers: [],
          reason: '宿主未提供 llm 服务（headless 或该 profile 未加载模型）—— 面板可以体检，但无法在面板内生成评审。',
        }
      }
      const providers = await listReviewModels(llm)
      return {
        ok: true,
        available: providers.some(item => item.models.length > 0),
        providers,
        reason: providers.some(item => item.models.length > 0) ? '' : 'llm 服务在，但没有可用的 provider/model。',
      }
    },

    /**
     * 启动一次评审任务，**立即返回 jobId**。
     * 真正的模型调用在后台跑；面板轮询 reviewPoll 取进度与结果。
     */
    async reviewStart(payload = {}) {
      const llm = llmOf()
      if (typeof llm?.stream !== 'function') {
        return { ok: false, error: { code: 'llm-unavailable', message: '宿主未提供 llm 服务，无法在面板内生成评审。' } }
      }

      // 取原文：粘贴文本优先，否则解 base64。
      let docText = ''
      let filename = String(payload.filename ?? '粘贴文本.txt')
      if (typeof payload.text === 'string' && payload.text.trim() !== '') {
        docText = payload.text
      } else {
        const base64 = String(payload.base64 ?? '')
        if (base64 === '') {
          return { ok: false, error: { code: 'bad-request', message: '缺少文件内容（base64）或 text' } }
        }
        const buffer = Buffer.from(base64, 'base64')
        const maxRpcBytes = Number(config.maxRpcBytes ?? 12 * 1024 * 1024)
        if (buffer.length > maxRpcBytes) {
          return {
            ok: false,
            error: {
              code: 'payload-too-large',
              message: `文件 ${(buffer.length / 1024 / 1024).toFixed(1)} MB 超过面板上限`,
              details: { maxRpcBytes },
            },
          }
        }
        const parsed = parseFile({ buffer, filename }, { maxChars: Number(config.maxChars ?? 600000) })
        if (parsed.coverage < 0.7) {
          return {
            ok: false,
            error: {
              code: 'parse-coverage-low',
              message: `解析覆盖率只有 ${(parsed.coverage * 100).toFixed(0)}% —— 基于不完整文本做评审没有意义。`,
              details: { coverage: parsed.coverage, warnings: parsed.warnings },
            },
          }
        }
        docText = parsed.text
      }

      if ([...docText].length > MAX_REVIEW_CHARS) {
        return {
          ok: false,
          error: {
            code: 'doc-too-long',
            message: `原文 ${[...docText].length} 字，超过单次评审上限 ${MAX_REVIEW_CHARS} 字。截断会毁掉"通读全文"这个前提，所以这里拒绝。`,
            details: { maxReviewChars: MAX_REVIEW_CHARS },
          },
        }
      }

      // 选模型：调用方指定优先；否则取第一个 provider 的第一个 model。
      const providers = await listReviewModels(llm)
      const usable = providers.filter(item => item.models.length > 0)
      if (usable.length === 0) {
        return { ok: false, error: { code: 'no-model', message: '没有可用的 provider/model，请先在设置里配置模型。' } }
      }
      // ★ 0.7.5 修：原先"所选 provider 恰好不可用"时，会悄悄换成 usable[0]，
      //   却仍保留你选的 model 名 —— 等于拿 A 家的模型名去调 B 家。
      //   现在 provider 找不到就整组回落；model 也必须确实属于该 provider。
      const requestedProvider = typeof payload.provider === 'string' ? payload.provider : ''
      const providerEntry = usable.find(item => item.id === requestedProvider) ?? usable[0]
      const provider = providerEntry.id
      const requestedModel = requestedProvider === provider && typeof payload.model === 'string' ? payload.model : ''
      const model = providerEntry.models.some(item => item.id === requestedModel)
        ? requestedModel
        : providerEntry.models[0].id

      const docId = docIdOf(docText)
      const controller = new AbortController()
      const job = {
        id: randomUUID(),
        state: 'running',
        startedAt: Date.now(),
        filename,
        docId,
        provider,
        model,
        receivedChars: 0,
        controller,
        report: null,
        review: null,
        error: null,
      }
      rememberJob(job)

      void (async () => {
        try {
          // ★ 0.7.11：面板上的「文档类型 / 提炼档位」是委托方对这份东西的定义与期望产出，
          //   以前只进了 audit 的旧维度与提炼页，模型收不到。现在原样喂给评审。
          const docTypeId = payload.docType ?? 'auto'
          const levelId = payload.level ?? 'summary'
          const docTypeMeta = DOC_TYPES.find(item => item.id === docTypeId)
          const levelMeta = LEVELS.find(item => item.id === levelId)
          // ★ 0.7.14：一次评审是 30–90 秒的长请求，传输层最容易被中间设备切断。
          //   实测症状：`error TRANSPORT / DeepSeek Messages transport failed`。
          //   这类失败**重试一次**通常就过，直接判死太重；而且它和"选哪个档位"无关
          //   （档位只改提示词里的一行文本），不能让人误以为是档位问题。
          const once = () => generateReview({
            llm,
            docText,
            task: payload.task,
            delivery: {
              docType: docTypeId,
              docTypeLabel: docTypeMeta?.label ?? docTypeId,
              docTypeSpecified: docTypeId !== 'auto',
              level: levelId,
              levelLabel: levelMeta?.label ?? levelId,
              levelDesc: levelMeta?.desc ?? '',
            },
            provider,
            model,
            signal: controller.signal,
            onProgress: chars => { job.receivedChars = chars },
          })

          const isTransport = error => {
            const code = String(error?.code ?? '')
            const text = String(error?.message ?? '')
            if (code === 'aborted') return false
            return /transport|timeout|timed out|ECONN|socket|stream-incomplete|network/i.test(`${code} ${text}`)
          }

          let review
          try {
            ({ review } = await once())
          } catch (error) {
            if (controller.signal.aborted || !isTransport(error)) throw error
            job.receivedChars = 0
            job.error = null
            await new Promise(resolve => { setTimeout(resolve, 2000) })
            ;({ review } = await once())
          }
          // ★ 评审绑定到**我们发出去的那一版原文**：docId 由宿主补，不靠模型自己编。
          //   校验器据此拒绝把旧评审套到改过的文件上。
          review.docId = docId
          if (typeof review.basis !== 'string') review.basis = 'none'
          // 记下**实际使用的**模型：报告抬头会印，否则"选的"和"用的"对不对无从核。
          review.model = { provider, model, at: new Date().toISOString() }
          // 原样留下评审：面板要拿它在"开始体检"时复用，否则两个按钮会互相覆盖
          // （先评审出分，再点体检，分数被一份无评审的报告顶掉）。
          job.review = review
          job.report = audit({
            buffer: Buffer.from(docText, 'utf8'),
            filename,
            docType: payload.docType ?? 'auto',
            level: payload.level ?? 'summary',
            source: 'panel-llm',
            config,
            review,
          })
          job.state = 'done'
          recent?.push?.(job.report)
        } catch (error) {
          job.state = 'failed'
          job.error = {
            code: String(error?.code ?? 'review-failed'),
            message: String(error?.message ?? error),
            details: (error?.details !== null && typeof error?.details === 'object') ? error.details : {},
          }
        }
      })()

      return {
        ok: true,
        jobId: job.id,
        provider,
        model,
        chars: [...docText].length,
        docId,
      }
    },

    /** 取一次评审进度。state: running / done / failed。 */
    async reviewPoll(payload = {}) {
      const job = jobs.get(String(payload.jobId ?? ''))
      if (job === undefined) {
        return {
          ok: false,
          error: {
            code: 'not-found',
            message: '这个评审任务已经不在内存里了（DSH 重启或超出保留条数会被清掉），请重新点「生成评审」。',
          },
        }
      }
      const base = {
        ok: true,
        state: job.state,
        receivedChars: job.receivedChars,
        elapsedMs: Date.now() - job.startedAt,
        provider: job.provider,
        model: job.model,
      }
      if (job.state === 'done') return { ...base, report: job.report, review: job.review ?? null }
      if (job.state === 'failed') return { ...base, error: job.error }
      return base
    },

    /** 取消一次评审（用户关掉面板或点取消）。 */
    async reviewCancel(payload = {}) {
      const job = jobs.get(String(payload.jobId ?? ''))
      if (job === undefined) return { ok: true, cancelled: false }
      try { job.controller.abort() } catch { /* 已经结束就无所谓 */ }
      return { ok: true, cancelled: true }
    },

    /** 体检：面板把文件读成 base64 送来。 */
    async audit(payload = {}) {
      const filename = String(payload.filename ?? '').trim()
      if (filename === '') {
        return { ok: false, error: { code: 'bad-request', message: '缺少 filename' } }
      }
      const base64 = String(payload.base64 ?? '')
      if (base64 === '') {
        return { ok: false, error: { code: 'bad-request', message: '缺少文件内容（base64）' } }
      }

      const buffer = Buffer.from(base64, 'base64')
      const maxRpcBytes = Number(config.maxRpcBytes ?? 12 * 1024 * 1024)
      if (buffer.length > maxRpcBytes) {
        return {
          ok: false,
          error: {
            code: 'payload-too-large',
            message: `文件 ${(buffer.length / 1024 / 1024).toFixed(1)} MB 超过面板上传上限 ${(maxRpcBytes / 1024 / 1024).toFixed(0)} MB`,
            details: { maxRpcBytes },
          },
        }
      }

      try {
        const report = audit({
          buffer,
          filename,
          docType: payload.docType ?? 'auto',
          level: payload.level ?? 'summary',
          source: 'panel-upload',
          config,
          // 四层十二格：0–4 由人/Agent 给，面板带上来即可；
          // 不带就全部 unrated —— 综合分不出，只出证据线索（这是刻意的，不是缺陷）。
          review: payload.review,
          cells: payload.cells,
          gaps: payload.gaps,
          pending: payload.pending,
        })
        recent?.push?.(report)
        return { ok: true, report }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error?.code ?? 'audit-failed',
            message: String(error?.message ?? error),
            details: { hint: error?.hint, stage: error?.stage },
          },
        }
      }
    },

    /** 体检纯文本（面板的「粘贴文本」标签页，与上传走同一条管线）。 */
    async auditText(payload = {}) {
      const text = String(payload.text ?? '')
      if (text.trim() === '') {
        return { ok: false, error: { code: 'bad-request', message: '没有可分析的文本' } }
      }
      try {
        const report = audit({
          buffer: Buffer.from(text, 'utf8'),
          filename: String(payload.filename ?? '粘贴文本.txt'),
          docType: payload.docType ?? 'auto',
          level: payload.level ?? 'summary',
          source: 'panel-text',
          config,
          review: payload.review,
          cells: payload.cells,
          gaps: payload.gaps,
          pending: payload.pending,
        })
        recent?.push?.(report)
        return { ok: true, report }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error?.code ?? 'audit-failed',
            message: String(error?.message ?? error),
            details: { hint: error?.hint, stage: error?.stage },
          },
        }
      }
    },

    /**
     * 四层试算 —— 面板填完 0–4 后只重算算术，**不重新解析文件**。
     *
     * 为什么要单开一个方法：重新走 audit 会把整份文档再解析一遍、再跑一遍提炼，
     * 用户每改一格就要等几秒；而层分只依赖 cells，是纯算术。
     */
    async layers(payload = {}) {
      const { evaluateLayers } = await import('./layers.mjs')
      return {
        ok: true,
        layers: evaluateLayers({
          cells: Array.isArray(payload.cells) ? payload.cells : [],
          gaps: Array.isArray(payload.gaps) ? payload.gaps : [],
          pending: Array.isArray(payload.pending) ? payload.pending : [],
        }),
      }
    },

    /** 只重跑提炼（换档位不必重新上传）。 */
    async redistribute(payload = {}) {
      const text = String(payload.text ?? '')
      if (text.trim() === '') {
        return { ok: false, error: { code: 'bad-request', message: '缺少原文，无法重新提炼' } }
      }
      const { distill } = await import('./distill.mjs')
      return { ok: true, distillation: distill(text, { level: payload.level ?? 'summary' }) }
    },

    /** 保存报告为 .md —— 仅当 profile 里配了 reportRoot 才允许落盘。 */
    async save(payload = {}) {
      const reportRoot = typeof config.reportRoot === 'string' ? config.reportRoot.trim() : ''
      if (reportRoot === '') {
        return {
          ok: false,
          error: {
            code: 'save-disabled',
            message: '未配置 reportRoot，插件不会向磁盘写任何文件。',
            details: { hint: '在 profile 的 cordis.patch.yml 里为 kill-ai-slop 设 reportRoot: <目录> 后重启 Host。' },
          },
        }
      }
      const markdown = String(payload.markdown ?? '')
      if (markdown.trim() === '') {
        return { ok: false, error: { code: 'bad-request', message: '没有可保存的内容' } }
      }
      const suggested = String(payload.filename ?? 'slop-report.md')
      const safeName = suggested.replace(/[\\/:*?"<>|]/gu, '_').slice(0, 120) || 'slop-report.md'

      const root = resolve(reportRoot)
      const target = resolve(root, safeName)
      const rel = relative(root, target)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { ok: false, error: { code: 'path-outside-root', message: `落盘路径不在 reportRoot 内：${target}`, details: { root } } }
      }

      await mkdir(root, { recursive: true })
      await writeFile(target, markdown, 'utf8')
      return { ok: true, path: target, bytes: Buffer.byteLength(markdown, 'utf8') }
    },

    /** 最近报告摘要（只在内存里，不写盘）。 */
    async recent() {
      return { ok: true, items: recent?.list?.() ?? [] }
    },

    /** 按序号取回某一份最近报告（面板里点击列表项时用）。 */
    async recentGet(payload = {}) {
      const found = recent?.get?.(payload.index)
      if (found === undefined) {
        return {
          ok: false,
          error: {
            code: 'not-found',
            message: '这份报告已经不在内存里了（DSH 重启或超出保留条数会被清掉），请重新体检。',
          },
        }
      }
      return { ok: true, report: found }
    },
  }

  const dispose = ctx.connection.fetch.register({
    path: `/api/${RPC_ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })

      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message?.payload
      if (message?.type !== 'client-request'
        || typeof message.rpcId !== 'string'
        || message.method !== RPC_ENDPOINT
        || call === null
        || typeof call !== 'object'
        || typeof call.method !== 'string') {
        return reply(rpcId, { ok: false, error: { code: 'bad-request', message: '请求信封不合法' } })
      }

      const handler = methods[call.method]
      if (typeof handler !== 'function') {
        return reply(rpcId, {
          ok: false,
          error: {
            code: 'unknown-method',
            message: `未知方法：${call.method}`,
            details: { available: Object.keys(methods) },
          },
        })
      }

      try {
        return reply(rpcId, await handler(call.payload ?? {}))
      } catch (error) {
        deps.logger?.warn?.(`[kill-ai-slop] RPC ${call.method} 失败：${error?.message ?? error}`)
        return reply(rpcId, {
          ok: false,
          error: {
            code: error?.code ?? 'handler-failed',
            message: String(error?.message ?? error),
            details: { hint: error?.hint },
          },
        })
      }
    },
  })

  deps.logger?.info?.(`[kill-ai-slop] RPC 端点已注册：/api/${RPC_ENDPOINT}（方法：${Object.keys(methods).join(', ')}）`)
  return dispose
}
