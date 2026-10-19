/**
 * 构建脚本 —— 生成 lib/（发布产物）。唯一真源在 plugin-src/。
 *
 *   npm run build
 *
 * ── 宿主半侧（plugin-src/host/ → lib/）────────────────────────────
 *   纯 ESM，**不做转换**：逐个复制，只在文件头加横幅。
 *   复制而不是 re-export，是为了让 lib/index.mjs 成为**真实文件**，
 *   发布物与源码同构、可被 DSH 插件加载器直接解析。
 *
 * ── 客户端半侧（plugin-src/client/ → lib/client.js）──────────────
 *   **不用打包器**。impl.mjs 被写成一个工厂函数 `createClientPlugin(React)`：
 *     · 构建时把顶层 `export ` 去掉，原样嵌进 wrapper 的 factory 体内；
 *     · React 由 factory 的参数 `require` 在运行时解析。
 *   为什么不用 esbuild：这里没有 JSX、没有第三方依赖要打包，
 *   引入打包器只会换来一个 npm 依赖、一次 postinstall 风险（pnpm 10+ 会拦）
 *   和一条"产物与源码不同构"的调试弯路。零依赖是刻意选择，不是偷懒。
 *
 * 装配策略：先造到 .lib-staging，全部通过才原子替换 lib/；失败时旧产物原样保留。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Script, runInNewContext } from 'node:vm'

import { auditMarkers } from './bundle-markers.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_HOST = join(ROOT, 'plugin-src', 'host')
const SRC_CLIENT = join(ROOT, 'plugin-src', 'client')
const LIB = join(ROOT, 'lib')
const STAGING = join(ROOT, '.lib-staging')
const BACKUP = join(ROOT, '.lib-backup')

const PACKAGE_NAME = '@yiyunet/dsh-kill-ai-slop'
const RPC_ENDPOINT = 'dsh-kill-ai-slop'
const PANEL_LABEL = 'AI垃圾过滤'
const FACTORY_NAME = 'createClientPlugin'
const IMPL_PLACEHOLDER = '// __DSH_CLIENT_IMPL__'

const BUILTIN_SPECIFIERS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
const HOST_ALLOWED_BARE = new Set(['@deepseek-ai/dsh-tools'])

const GENERATED_BANNER = name =>
  '// ⚠️ 本文件由 `npm run build` 从 plugin-src/ 生成 —— 请勿直接编辑。\n'
  + `// 真源：plugin-src/${name}\n`

const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Windows 上刚写入的目录被 rename 可能遇瞬时 EPERM（杀软/索引器/文件监听持有句柄）。
 * POSIX 无此问题，故 Linux CI 不会触发 —— 但不重试会把"等一秒就好"变成构建失败。
 */
async function withTransientRetry(operation, what, { attempts = 6, baseDelayMs = 200 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!TRANSIENT_FS_CODES.has(error?.code)) throw error
      if (attempt >= attempts) {
        throw new Error(`${what} 失败：连续 ${attempts} 次遇到瞬时文件锁（${error?.code}）。`
          + '\n  · 常见原因：杀毒软件实时扫描 / Windows 搜索索引器 / 正在加载本插件的宿主进程 DSH'
          + '\n  · 处理：关掉占用该目录的程序后重跑 `npm run build`'
          + `\n  · 原始错误：${error.message}`)
      }
      console.warn(`  · 瞬时文件锁（${error?.code}）：${what} → ${baseDelayMs * attempt}ms 后重试（第 ${attempt} 次）`)
      await new Promise(done => { setTimeout(done, baseDelayMs * attempt) })
    }
  }
}

async function walk(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** 抽出所有 import/export-from 的裸模块名。 */
function bareImportsOf(source) {
  const names = new Set()
  const patterns = [
    /^\s*import\s+[^'"]*?from\s*['"]([^'"]+)['"]/gmu,
    /^\s*import\s*['"]([^'"]+)['"]/gmu,
    /^\s*export\s+[^'"]*?from\s*['"]([^'"]+)['"]/gmu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1])
  }
  return [...names].filter(specifier => !specifier.startsWith('.') && !specifier.startsWith('/'))
}

/* ─────────────────────── 宿主半侧 ─────────────────────── */

async function buildHost() {
  const files = await walk(SRC_HOST)
  if (files.length === 0) throw new Error('plugin-src/host/ 是空的')
  if (!files.some(file => relative(SRC_HOST, file) === 'index.mjs')) {
    throw new Error('plugin-src/host/index.mjs 不存在 —— 宿主入口缺失，发布物会是空的')
  }

  const notices = []
  for (const file of files) {
    const relativePath = relative(SRC_HOST, file).split(sep).join('/')
    const source = await readFile(file, 'utf8')

    for (const specifier of bareImportsOf(source)) {
      if (BUILTIN_SPECIFIERS.has(specifier)) continue
      if (HOST_ALLOWED_BARE.has(specifier)) continue
      if (specifier.startsWith('@deepseek-ai/')) continue
      notices.push(`plugin-src/host/${relativePath} 引入了 "${specifier}" —— `
        + '本插件声明零运行时依赖，请改用 node: 内置模块，或先确认该包会由 Host 提供')
    }

    const target = join(STAGING, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, GENERATED_BANNER(`host/${relativePath}`) + source, 'utf8')
  }

  const entry = join(STAGING, 'index.mjs')
  const entryStat = await stat(entry).catch(() => undefined)
  if (entryStat === undefined || !entryStat.isFile()) {
    throw new Error(`lib/index.mjs 写出后不存在（目标路径：${entry}）`)
  }
  return { count: files.length, notices }
}

/* ─────────────────────── 客户端半侧 ─────────────────────── */

/**
 * 把 V8 的 SyntaxError 翻译成"第几行、那行长什么样、指到哪一列"。
 *
 * 为什么需要：`SyntaxError: missing ) after argument list` 这句话本身**不包含位置**，
 * 而 600 行的客户端文件靠肉眼找括号失衡基本找不出来（本次就吃过一次：
 * 报错只说"少了右括号"，构建里却没有行号，只能靠猜）。
 * V8 把位置放在 `error.stack` 的第一行（形如 `lib/client.js:445`），这里把它取出来。
 */
function describeSyntaxError(source, error, filename) {
  const stack = String(error?.stack ?? '')
  const firstLine = stack.split('\n')[0]?.trim() ?? ''
  const position = /:(\d+)(?::(\d+))?$/u.exec(firstLine)
  const matched = position?.[1] === undefined ? null : Number(position[1])

  const out = [`${error?.name ?? 'Error'}: ${error?.message ?? error}`]

  if (matched !== null && Number.isFinite(matched) && matched >= 1) {
    const lines = String(source).split('\n')
    const from = Math.max(1, matched - 2)
    const to = Math.min(lines.length, matched + 2)
    for (let at = from; at <= to; at += 1) {
      out.push(`  ${String(at).padStart(5)} | ${lines[at - 1]}`)
    }
    out.push(`  ${' '.repeat(String(to).length + 2)}^ ${filename}:${matched} 附近`)
  } else {
    out.push('  （V8 未给出位置，下面是堆栈前 3 行）')
    for (const entry of stack.split('\n').slice(0, 3)) out.push(`  ${entry}`)
    out.push('  → 跑 `node --check plugin-src/client/impl.mjs` 可拿到精确位置')
  }
  return out.join('\n')
}

/** 顶层 `export ` 去掉（只处理行首的 export 声明，不动字符串里的词）。 */
function stripTopLevelExports(source) {
  return source.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gmu, '')
}

async function buildClient() {
  const wrapper = await readFile(join(SRC_CLIENT, 'index.mjs'), 'utf8')
  const implPath = join(SRC_CLIENT, 'impl.mjs')
  const impl = await readFile(implPath, 'utf8')

  if (!wrapper.includes(IMPL_PLACEHOLDER)) {
    throw new Error(`plugin-src/client/index.mjs 缺少占位符 ${IMPL_PLACEHOLDER}`)
  }

  // 前置断言：impl 不得有 import（平台只通过 factory 的 require 给 React）
  if (/^\s*import\s/mu.test(impl)) {
    throw new Error('plugin-src/client/impl.mjs 不得包含 import —— '
      + `React 必须通过工厂参数取得（包装成 ${FACTORY_NAME}(React)）`)
  }

  const exportLines = [...impl.matchAll(/^export\s+.*$/gmu)].map(match => match[0].trim())
  if (exportLines.length !== 1) {
    throw new Error(`plugin-src/client/impl.mjs 顶层 export 必须恰好 1 个（当前 ${exportLines.length} 个）：\n`
      + exportLines.map(line => `  · ${line}`).join('\n')
      + `\n  → 需要且只需要一个 \`export function ${FACTORY_NAME}(React)\`；其余声明请放在工厂体内。`)
  }
  if (!exportLines[0].startsWith(`export function ${FACTORY_NAME}(`)) {
    throw new Error(`plugin-src/client/impl.mjs 的顶层 export 必须是 \`export function ${FACTORY_NAME}(React)\`，`
      + `当前是：${exportLines[0]}`)
  }

  // ⚠️ 这里曾被写成 `body.trimStart().startsWith('function createClientPlugin(')` —— 那是**错的**：
  //    impl.mjs 顶上有一大段文件头注释（说明"为什么写成工厂函数"），去掉 export 后文件仍以
  //    `/** … */` 开头，于是这条断言必然失败，把一次正确的变换判成"变换规则与源码不同步"。
  //    断言要断的是**语义**，不是**首字符位置**：
  //      ① 工厂函数声明还在；
  //      ② 顶层已经没有任何 export 残留（这才是变换真正要保证的事）。
  const body = stripTopLevelExports(impl)
  if (!body.includes(`function ${FACTORY_NAME}(`)) {
    throw new Error(`去掉 export 后 impl.mjs 里找不到 \`function ${FACTORY_NAME}(\` —— 变换规则与源码不同步`)
  }
  if (/^export\s/mu.test(body)) {
    const leftover = [...body.matchAll(/^export\s.*$/gmu)].map(match => match[0].trim())
    throw new Error('去掉 export 后 impl.mjs 仍残留顶层 export，嵌入 factory 会变成非法语法：\n'
      + leftover.map(line => `  · ${line}`).join('\n'))
  }

  // ★ 分两步解析，把"错在 impl"与"错在装配"分成两种不同的报错 ——
  //   混在一起时，一旦装配报错就会误判成"impl 放错位置了"，浪费整轮排查。
  //   ① impl（去掉 export 后）本身必须是合法脚本：它只含一个函数声明，单独可解析。
  try {
    new Script(body, { filename: 'client-impl.js' })
  } catch (error) {
    throw new Error('plugin-src/client/impl.mjs 去掉顶层 export 后本身就有语法错误：\n'
      + describeSyntaxError(body, error, 'impl.mjs(去 export 后)')
      + '\n  → 行号与 impl.mjs 基本一一对应（少了 `export ` 六个字符，不影响行数）。')
  }

  // 用函数式替换：字符串替换会把 impl 里的 `$&` / `$1` 之类当成替换模式解释掉
  const output = wrapper.replace(IMPL_PLACEHOLDER, () => body.trim())

  // ② 装配后的整体也必须是合法脚本；走到这里还错，就是 wrapper 或拼接处的问题。
  try {
    new Script(output, { filename: 'lib/client.js' })
  } catch (error) {
    throw new Error('装配后的 lib/client.js 有语法错误（impl 单独可解析 ⇒ 问题在 wrapper 或拼接处）：\n'
      + describeSyntaxError(output, error, 'lib/client.js'))
  }

  await mkdir(STAGING, { recursive: true })
  await writeFile(join(STAGING, 'client.js'), output, 'utf8')

  const written = await readFile(join(STAGING, 'client.js'), 'utf8')
  if (written.trim() === '') throw new Error('lib/client.js 写出后为空 —— 写入环节异常')

  const { missing, escapedOnly } = auditMarkers(written, [
    { label: '装载器 id', needle: PACKAGE_NAME },
    { label: '面板挂载点', needle: 'settings.section' },
    { label: '面板 id', needle: `'${RPC_ENDPOINT}'` },
    { label: '面板 label', needle: PANEL_LABEL },
    { label: '面板 label（英文）', needle: 'Kill AI Slop' },
    { label: '工厂名', needle: FACTORY_NAME },
    { label: 'RPC 端点名', needle: RPC_ENDPOINT },
  ])
  if (missing.length > 0) {
    throw new Error(`lib/client.js 写出后缺少关键标记：${missing.map(item => `${item.label}「${item.needle}」`).join('、')}\n`
      + '  → 若源码里也没有该串，那是契约漂移，改源码而非改构建。')
  }

  // 装载层自证：用最小 __ModuleLoader__ 桩把产物真跑一遍。
  // 只查字符串不够 —— 曾出现"产物看着对、顶层执行就抛错"，症状会报在别的插件上。
  const registrations = []
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, TextEncoder, TextDecoder, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
    location: { href: 'http://localhost/' },
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    requestAnimationFrame: callback => setTimeout(callback, 0),
    document: {
      currentScript: null,
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {} }),
      head: { appendChild() {} },
    },
    window: { __ModuleLoader__: { mode: 'queue', load: registration => registrations.push(registration) } },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  try {
    runInNewContext(written, sandbox, { filename: 'lib/client.js' })
  } catch (error) {
    throw new Error(`lib/client.js 顶层执行抛错（注意：这是**运行期**错误，不是语法错误）：\n`
      + `${describeSyntaxError(written, error, 'lib/client.js')}\n`
      + '  → 最常见原因：impl 被放到了 factory 外面（React 会在顶层被解析成 undefined）。')
  }

  if (!registrations.some(item => item?.id === PACKAGE_NAME)) {
    throw new Error(`lib/client.js 执行后没有注册 ${PACKAGE_NAME} —— 装载器契约被破坏`)
  }

  const requireCalls = []
  let face
  try {
    face = registrations[0].factory(specifier => {
      requireCalls.push(specifier)
      if (specifier === 'react') {
        return {
          createElement: () => null,
          Fragment: 'Fragment',
          useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
          useEffect: () => {},
          useCallback: fn => fn,
          useMemo: fn => fn(),
          useRef: value => ({ current: value }),
        }
      }
      return new Proxy({}, { get: () => () => undefined })
    })
  } catch (error) {
    throw new Error(`lib/client.js 的 factory 执行抛错：${error?.name}: ${error?.message}`)
  }

  if (typeof face?.apply !== 'function' || typeof face?.name !== 'string' || !Array.isArray(face?.inject)) {
    throw new Error('lib/client.js 的工厂面缺少 { name, inject, apply } 三者之一 —— 客户端插件不会生效')
  }
  if (!face.inject.includes('connection') || !face.inject.includes('slots')) {
    throw new Error(`客户端 inject 必须包含 slots 与 connection，当前：${JSON.stringify(face.inject)}`)
  }

  console.log(`  · 装载验证：顶层执行 OK，注册 OK，factory require(${requireCalls.join(', ') || 'none'})，导出 {name,inject,apply} OK`)
  return { bytes: Buffer.byteLength(output, 'utf8'), escapedOnly }
}

/* ───────────────────────────── 装配 ───────────────────────────── */

await rm(STAGING, { recursive: true, force: true })
await mkdir(STAGING, { recursive: true })

try {
  const host = await buildHost()
  console.log(`✓ 宿主半侧：${host.count} 个文件 → lib/`)
  for (const notice of host.notices) console.log(`  · ${notice}`)

  const client = await buildClient()
  console.log(`✓ 客户端半侧：lib/client.js（${(client.bytes / 1024).toFixed(1)} KB）`)
  if (client.escapedOnly.length > 0) {
    console.log(`  · 以下标记在产物里是 \\uXXXX 转义形态（非故障）：${client.escapedOnly.join('、')}`)
  }

  // 原子替换 + 备份兜底：任一步失败都能从 .lib-backup 还原，不出现"两份都没有"的窗口。
  await withTransientRetry(() => rm(BACKUP, { recursive: true, force: true }), '清理上一次留下的 .lib-backup')
  const hadLib = await stat(LIB).then(info => info.isDirectory()).catch(() => false)
  if (hadLib) await withTransientRetry(() => rename(LIB, BACKUP), '把旧 lib/ 挪成 .lib-backup')
  try {
    await withTransientRetry(() => rename(STAGING, LIB), '把暂存区就位为 lib/')
  } catch (error) {
    let rollbackNote = ''
    if (hadLib) {
      try {
        await withTransientRetry(() => rename(BACKUP, LIB), '回滚 .lib-backup → lib/', { attempts: 3 })
      } catch (rollbackError) {
        rollbackNote = `；⚠️ 且回滚也失败：${rollbackError.message}\n  · 旧产物仍在 ${BACKUP}，可手动改名回 lib/ 恢复`
      }
    }
    throw new Error(`替换 lib/ 失败${rollbackNote}。原始错误：${error?.message ?? error}`)
  }
  await withTransientRetry(() => rm(BACKUP, { recursive: true, force: true }), '清理 .lib-backup')
  console.log('  · 产物已原子替换 lib/')
} catch (error) {
  await rm(STAGING, { recursive: true, force: true }).catch(() => {})
  console.error(`\n✗ 构建失败：\n${error?.message ?? error}\n`)
  const libExists = await stat(LIB).then(info => info.isDirectory()).catch(() => false)
  console.error(libExists
    ? '✓ 旧的 lib/ 未被改动 —— 插件仍可用旧版本。'
    : '! 当前没有 lib/，插件在 DSH 里无法加载。修好原因后重跑 `npm run build`。')
  process.exit(1)
}

const produced = (await walk(LIB)).map(file => `lib/${relative(LIB, file).split(sep).join('/')}`).sort()
console.log(`\nlib/ 实际落盘 ${produced.length} 个文件：`)
for (const file of produced) console.log(`  · ${file}`)
if (!produced.includes('lib/index.mjs') || !produced.includes('lib/client.js')) {
  console.error('\n✗ 缺少 lib/index.mjs 或 lib/client.js —— 发布物不完整。')
  process.exit(1)
}

console.log('\n构建完成。下一步：npm test && npm run verify')
