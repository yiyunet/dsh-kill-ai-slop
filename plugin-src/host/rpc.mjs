/**
 * 客户端 ↔ 宿主 RPC —— 设置面板通过它做上传、体检、保存。
 *
 * ★ 响应信封形状是硬性的（已实测；改了会静默失效）：
 *     成功 → { type:'server-response', rpcId, result:{ ok:true, value:<载荷> } }
 *     失败 → { type:'server-response', rpcId, result:{ ok:false, error:{ code, message, details:{…} } } }
 *   把载荷直接摊在 result 上（而不是 result.value）会导致面板渲染出一片空壳，
 *   而 RPC 本身**不报错** —— 这类静默失效最难查，故形状写死在这里，只有一个出口 `reply()`。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { ENGINE_VERSION, audit } from './audit.mjs'
import { DOC_TYPES, RULESET_VERSION } from './rules.mjs'
import { LEVELS } from './distill.mjs'

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
  const { config = {}, recent } = deps

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
        limits: {
          maxFileBytes: Number(config.maxFileBytes ?? 20 * 1024 * 1024),
          maxRpcBytes: Number(config.maxRpcBytes ?? 12 * 1024 * 1024),
          maxChars: Number(config.maxChars ?? 600000),
        },
        privacy: {
          includeSnippets: config.includeSnippets !== false,
          reportRoot: typeof config.reportRoot === 'string' ? config.reportRoot : '',
        },
        disclaimer: '判的是文件能不能用，不鉴定作者、不评人。零联网、零上传：所有计算在本机 Host 进程内完成。',
      }
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
