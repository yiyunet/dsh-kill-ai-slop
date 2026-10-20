/**
 * 发布契约校验 —— `npm run verify`。
 *
 * 校验的不是"代码对不对"，而是**发布形态有没有被破坏**。
 * 每一条断言都对应一个真实踩过的坑，删任何一条都会让某一类缺陷静默通过。
 *
 *   ① 必需文件齐全
 *   ② 依赖禁则：任何依赖节都不得出现 @deepseek-ai/dsh-*
 *      —— DSH 运行时包用**模块局部 Symbol** 做 key，装第二份物理副本会破坏 Host 查找
 *   ③ **零运行时依赖**（本插件特有承诺）：dependencies / optionalDependencies / peerDependencies
 *      必须为空（cordis 为可选 peer，见 ②-2 白名单）
 *      —— "离线、可审计、装完就能跑"是这份插件的卖点，加一个依赖就破了这个承诺
 *   ④ 客户端产物注册了正确的装载器 id
 *   ⑤ 客户端产物注册了正确的设置面板契约（挂载点 / id / order / label / 英文名）
 *   ⑥ 客户端产物不含 ESM 顶层 import/export（它是包装后的浏览器脚本，不是源码）
 *   ⑦ RPC 端点名在宿主真源、客户端真源、客户端产物三处一致
 *      —— 曾因响应信封形状不一致导致面板渲染空壳而 RPC 不报错，端点名漂移同理致命
 *   ⑧ 脱敏扫描（个人路径 / 硬编码凭证 / 内部体系词汇）
 *   ⑨ files 白名单自洽 ＋ 安装期脚本禁则（pnpm 10+ 会拦 postinstall，消费者安装直接失败）
 *   ⑩ 版本一致性：规则集版本在宿主源码与产物里一致；引擎版本在 audit.mjs 与 README 里一致
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { containsMarker, decodeEscapes } from './bundle-markers.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const failures = []

const check = (condition, message) => { if (!condition) failures.push(message) }

async function readIfExists(relativePath) {
  try {
    return await readFile(resolve(ROOT, relativePath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function readJson(relativePath) {
  const text = await readIfExists(relativePath)
  if (text === undefined) {
    failures.push(`缺少必需文件：${relativePath}`)
    return {}
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    failures.push(`${relativePath} 不是合法 JSON：${error.message}`)
    return {}
  }
}

/* ── ① 必需文件 ─────────────────────────────────────────────────────── */
const HOST_SOURCES = ['index.mjs', 'audit.mjs', 'parse.mjs', 'rules.mjs', 'score.mjs', 'distill.mjs', 'text.mjs', 'rpc.mjs', 'obligations.mjs']
const REQUIRED = [
  'lib/index.mjs',
  'lib/client.js',
  'plugin-src/client/index.mjs',
  'plugin-src/client/impl.mjs',
  ...HOST_SOURCES.map(name => `plugin-src/host/${name}`),
  'scripts/build.mjs',
  'scripts/bundle-markers.mjs',
  'scripts/verify-package.mjs',
  'scripts/doctor.mjs',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
  'CONTEXT.md',
  'THIRD_PARTY_NOTICES.md',
  'assets/README.md',
  'assets/logo.svg',
]
for (const relativePath of REQUIRED) {
  const info = await stat(resolve(ROOT, relativePath)).catch(() => undefined)
  check(info?.isFile() === true, `缺少必需文件：${relativePath}`)
}

/* ── ② 依赖禁则 ─────────────────────────────────────────────────────── */
const manifest = await readJson('package.json')
const FORBIDDEN = /^@deepseek-ai\/dsh-/u
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    check(!FORBIDDEN.test(name),
      `${name} 不得出现在 ${section} —— DSH 运行时包必须由 Host 提供；`
      + '装第二份物理副本会用模块局部 Symbol 破坏 Host 查找')
  }
}
for (const name of manifest.bundleDependencies ?? manifest.bundledDependencies ?? []) {
  check(!FORBIDDEN.test(name), `${name} 不得被打包（bundleDependencies）—— 必须来自 Host`)
}

/* ── ③ 零运行时依赖（本插件特有承诺）───────────────────────────────── */
const ALLOWED_PEER = new Set(['@deepseek-ai/cordis'])
check(Object.keys(manifest.dependencies ?? {}).length === 0,
  `本插件承诺零运行时依赖，但 dependencies 非空：${Object.keys(manifest.dependencies ?? {}).join(', ')}`
  + '；请改用 node: 内置模块，或先在 README 里撤回"零依赖"的说法')
check(Object.keys(manifest.optionalDependencies ?? {}).length === 0,
  `optionalDependencies 必须为空：${Object.keys(manifest.optionalDependencies ?? {}).join(', ')}`)
for (const name of Object.keys(manifest.peerDependencies ?? {})) {
  check(ALLOWED_PEER.has(name), `peerDependencies 只允许 ${[...ALLOWED_PEER].join(' / ')}，发现了 ${name}`)
}

/* ── ④⑤⑥ 客户端产物契约 ────────────────────────────────────────────── */
const clientBundle = await readIfExists('lib/client.js')
const clientSource = await readIfExists('plugin-src/client/impl.mjs')

if (clientBundle === undefined) {
  check(false, 'lib/client.js 不存在 —— 先跑 npm run build')
} else if (clientBundle.trim() === '') {
  check(false, 'lib/client.js 是空文件 —— 请跑 npm run build 生成真产物')
} else {
  const bundleKb = (Buffer.byteLength(clientBundle, 'utf8') / 1024).toFixed(1)
  const sizeHint = `（实测 ${bundleKb} KB）`
  const escapeHint = ' —— 若确认是转义形态，请跑 node scripts/build.mjs 复核'

  check(containsMarker(clientBundle, '@yiyunet/dsh-kill-ai-slop'),
    `lib/client.js 未注册装载器 id（应为 @yiyunet/dsh-kill-ai-slop）${sizeHint}`)
  check(containsMarker(clientBundle, 'settings.section'),
    `lib/client.js 未注册设置面板挂载点（settings.section）${sizeHint}`)
  check(containsMarker(clientBundle, 'dsh-kill-ai-slop'),
    `lib/client.js 未注册设置面板 id / RPC 端点名（dsh-kill-ai-slop）${sizeHint}`)
  check(/\border\s*:\s*23\b/u.test(decodeEscapes(clientBundle)),
    `lib/client.js 的设置面板 order 不是 23（排序号须大于既有面板）${sizeHint}`)
  check(containsMarker(clientBundle, 'AI垃圾过滤'),
    `lib/client.js 未注册设置面板中文 label「AI垃圾过滤」${sizeHint}${escapeHint}`)
  check(containsMarker(clientBundle, 'Kill AI Slop'),
    `lib/client.js 未注册英文名「Kill AI Slop」${sizeHint}${escapeHint}`)
  check(containsMarker(clientBundle, 'createClientPlugin'),
    `lib/client.js 里找不到工厂名 createClientPlugin —— 构建变换可能与源码不同步${sizeHint}`)

  check(!/^\s*(?:import|export)\s/mu.test(clientBundle),
    'lib/client.js 含 ESM 顶层 import/export —— 它是包装后的浏览器脚本，出现源码语法说明有人直接改过产物')

  // 交叉验证：源码里有、产物里没有 ⇒ 产物过期
  if (clientSource !== undefined) {
    for (const needle of ['AI垃圾过滤', 'Kill AI Slop', 'settings.section']) {
      if (containsMarker(clientSource, needle) && !containsMarker(clientBundle, needle)) {
        check(false, `源码 impl.mjs 有「${needle}」但产物没有 —— 产物过期，重跑 npm run build`)
      }
    }
  }
}

if (clientSource !== undefined) {
  check(/^export\s+function\s+createClientPlugin\s*\(/mu.test(clientSource),
    'plugin-src/client/impl.mjs 必须且只能导出一个 `export function createClientPlugin(React)`')
  check(!/^\s*import\s/mu.test(clientSource),
    'plugin-src/client/impl.mjs 不得含 import —— React 必须通过工厂参数注入')
}

/* ── ⑦ RPC 端点名三处一致 ───────────────────────────────────────────── */
const hostRpc = await readIfExists('plugin-src/host/rpc.mjs')
const hostEndpoint = /RPC_ENDPOINT\s*=\s*['"]([^'"]+)['"]/u.exec(hostRpc ?? '')?.[1]
const clientEndpoint = /RPC_ENDPOINT\s*=\s*['"]([^'"]+)['"]/u.exec(clientSource ?? '')?.[1]
check(typeof hostEndpoint === 'string' && hostEndpoint !== '', 'plugin-src/host/rpc.mjs 未声明 RPC_ENDPOINT')
check(typeof clientEndpoint === 'string' && clientEndpoint !== '', 'plugin-src/client/impl.mjs 未声明 RPC_ENDPOINT')
check(hostEndpoint === clientEndpoint,
  `RPC 端点名不一致：宿主「${hostEndpoint}」 vs 客户端「${clientEndpoint}」—— 面板会静默失效`)
check(clientBundle === undefined || clientBundle.trim() === '' || containsMarker(clientBundle, clientEndpoint ?? '\u0000'),
  `lib/client.js 里找不到端点名「${clientEndpoint}」—— 产物可能过期`)

/* ── ⑦′ 「保存报告」必须由使用者选位置，不得依赖宿主配置 ──────────────── */
// 实测踩过：点保存直接报「未配置 reportRoot，插件不会向磁盘写任何文件」。
// 那是把"保存一个刚生成的文件"变成了"先改 profile 配置再重启 Host" —— 设计错误。
// 现在改为浏览器侧 showSaveFilePicker（原生另存为对话框），宿主零写入、零配置。
if (clientSource !== undefined) {
  check(/showSaveFilePicker/u.test(clientSource),
    'plugin-src/client/impl.mjs 缺 showSaveFilePicker —— 保存会退回浏览器下载，落点不再由使用者决定')
  check(!/\brpc\(\s*['"]save['"]/u.test(clientSource),
    'plugin-src/client/impl.mjs 又在调宿主 save RPC —— 那要求先配 reportRoot，点保存会直接报错')
  // 默认文件名要人人看得懂：`toISOString()` 给的是 UTC，与使用者本地时间差时区
  // （实测存出了 `2026-10-19-04-02-51-…`，而本地是 12:02:51，谁也不知道那串数字是什么）。
  check(!/toISOString/u.test(clientSource),
    'plugin-src/client/impl.mjs 出现 toISOString —— UTC 时间不能进入给用户看的界面或文件名')
}
if (clientBundle !== undefined && clientBundle.trim() !== '') {
  check(containsMarker(clientBundle, 'showSaveFilePicker'),
    'lib/client.js 里没有 showSaveFilePicker —— 产物过期，重跑 npm run build')
}

/* ── ⑧ 脱敏扫描（个人路径 / 凭证 / 内部体系词汇）───────────────────────── */
const SCAN_FILES = [
  'package.json', 'cordis.patch.yml', 'README.md', 'README.en.md',
  'CONTEXT.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  'plugin-src/client/index.mjs', 'plugin-src/client/impl.mjs',
  ...HOST_SOURCES.map(name => `plugin-src/host/${name}`),
  'scripts/build.mjs', 'scripts/verify-package.mjs', 'scripts/doctor.mjs',
]
const SENSITIVE = [
  { pattern: /[A-Za-z]:[\\/]{1,2}Users[\\/][A-Za-z0-9._-]+/u, label: 'Windows 个人绝对路径' },
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//u, label: 'macOS 个人绝对路径' },
  { pattern: /\/home\/[A-Za-z0-9._-]+\//u, label: 'Linux 个人绝对路径' },
  { pattern: /\b(?:clientSecret|apiKey|authToken)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/u, label: '疑似硬编码凭证' },
]

/**
 * 内部体系词汇 —— 不含任何个人隐私，但会把"内部有多少套文档体系、组织怎么分工、
 * 业务做什么品类"泄露给外部读者。它比路径难发现得多，因为读起来完全正常。
 *
 * ★ 为什么要单独一组：本文件自身必须写出这批词才能扫描它们，
 *   若与应用合并成一组，扫描器会把自己标成违规。故对**本文件**跳过这组词，
 *   路径与凭证那组仍然对它全量生效。
 *   留下的缝隙：有人可以把内部词写进本文件注释而不被发现 —— 靠 review 兜底。
 *   代价明显小于"扫描器每天误报自己"，而误报会让整道闸门被当成噪音关掉。
 */
const INTERNAL_VOCAB = [
  { pattern: /\bN\d{2}\b/u, label: '内部知识节点编号' },
  { pattern: /技术部|封神榜/u, label: '内部组织名称' },
  { pattern: /最终决策权在|请老板|向老板/u, label: '内部汇报关系用语' },
  { pattern: /钉钉|dingtalk/iu, label: '内部相邻系统名' },
  { pattern: /热成像|声成像|跨境电商|FOTRIC/iu, label: '内部业务域词（产品线 / 行业 / 品牌）' },
  { pattern: /\b[EF]\s?档/u, label: '内部档位行话' },
  { pattern: /约束\s*\d|第\s*\d\s*条约束/u, label: '悬空条款编号（读者无法解析，但暴露"存在编号体系"）' },
]

const VOCAB_EXEMPT = 'scripts/verify-package.mjs'

for (const relativePath of SCAN_FILES) {
  const text = await readIfExists(relativePath)
  if (text === undefined) continue
  for (const { pattern, label } of SENSITIVE) {
    if (pattern.test(text)) failures.push(`${relativePath} 命中敏感模式（${label}）—— 发布前必须清除`)
  }
  if (relativePath === VOCAB_EXEMPT) continue
  for (const { pattern, label } of INTERNAL_VOCAB) {
    if (pattern.test(text)) failures.push(`${relativePath} 命中内部词汇（${label}）—— 发布前必须清除`)
  }
}

/* ── ⑨ files 白名单自洽 ＋ 安装期脚本禁则 ───────────────────────────── */
const filesWhitelist = Array.isArray(manifest.files) ? manifest.files : []
check(filesWhitelist.length > 0,
  'package.json 缺少 files 白名单 —— 发布时会把杂物一并带上')

for (const entry of filesWhitelist) {
  const info = await stat(resolve(ROOT, entry)).catch(() => undefined)
  check(info !== undefined,
    `files 白名单里的「${entry}」在仓库中不存在 —— 发布产物会缺件（npm 只会给个易忽略的警告）`)
}

const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepack', 'postpack', 'prepare', 'prepublishOnly']
for (const hook of LIFECYCLE_HOOKS) {
  const command = manifest.scripts?.[hook]
  if (typeof command !== 'string') continue
  for (const match of command.matchAll(/(?:^|\s)((?:\.\/)?scripts\/[^\s'"]+)/gu)) {
    const referenced = match[1].replace(/^\.\//u, '')
    const topLevel = referenced.split('/')[0]
    check(filesWhitelist.includes(topLevel) || filesWhitelist.includes(referenced),
      `${hook} 引用了「${referenced}」，但 files 白名单里没有「${topLevel}」—— `
      + '本地 link: 装载时问题不显形，npm publish 后安装方会因找不到该文件而失败')
  }
}

const ALWAYS_PACKED = /^(?:package\.json|readme(?:\..*)?|licen[cs]e(?:\..*)?)$/iu
const declaredEntries = [
  manifest.main,
  ...Object.values(manifest.exports ?? {}).filter(target => typeof target === 'string'),
  ...Object.values(manifest.bin ?? {}),
  typeof manifest.dsh?.client?.entry === 'string' ? manifest.dsh.client.entry : undefined,
].filter(target => typeof target === 'string' && target !== '')

for (const entry of declaredEntries) {
  const normalized = entry.replace(/^\.\//u, '')
  const basename = normalized.split('/').at(-1) ?? normalized
  if (ALWAYS_PACKED.test(basename)) continue
  const topLevel = normalized.split('/')[0]
  check(filesWhitelist.includes(normalized) || filesWhitelist.includes(topLevel),
    `package.json 声明的入口「${entry}」不在 files 白名单内 —— 发布后该入口会缺失`)
}

// 安装期/构建期钩子一律禁止。理由不是「不优雅」，是**会装不上**：
// 从 git 或 tarball 来源安装时，宿主会要求执行这些脚本，而 pnpm 10+
// 默认不执行依赖的构建脚本 —— 没有 allowBuilds 白名单就整包装不上。
// 实测踩过：0.3.8 之前声明了 prepare，员工在桌面客户端安装直接报
//   ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED（is not in the "allowBuilds" allowlist）
// 构建由 prepublishOnly 覆盖；产物 lib/ 已入库，消费者侧本来就不需要构建。
// 注：prepack 疑为同类（安装 git 依赖时也可能被要求执行），未实测，同样不要用。
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  check(!(hook in (manifest.scripts ?? {})),
    `package.json 不得声明 \`${hook}\` —— 从 git 来源安装时宿主要求执行该脚本，`
    + '默认开启构建脚本审批的环境会直接拒绝（ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED），'
    + '消费者侧装不上。构建交给 prepublishOnly；lib/ 已入库，安装不需要构建')
}

/* ── ⑩ 版本一致性 ───────────────────────────────────────────────────── */
const rulesSource = await readIfExists('plugin-src/host/rules.mjs')
const rulesVersion = /RULESET_VERSION\s*=\s*['"]([^'"]+)['"]/u.exec(rulesSource ?? '')?.[1]
check(typeof rulesVersion === 'string' && rulesVersion !== '',
  'plugin-src/host/rules.mjs 未声明 RULESET_VERSION（规则变更必须换版本，否则新旧分数不可比）')
// 规则集版本只存在于宿主侧：客户端不持有任何规则，改规则不需要重新发客户端。
check(!containsMarker(clientBundle ?? '', 'slop-rules/'),
  'lib/client.js 里出现了规则集版本号 —— 客户端不应持有规则，否则判定逻辑会出现两个真源')

const auditSource = await readIfExists('plugin-src/host/audit.mjs')
const engineVersion = /ENGINE_VERSION\s*=\s*['"]([^'"]+)['"]/u.exec(auditSource ?? '')?.[1]
check(typeof engineVersion === 'string' && engineVersion !== '',
  'plugin-src/host/audit.mjs 未声明 ENGINE_VERSION')
check(manifest.version === engineVersion,
  `package.json 版本（${manifest.version}）与 ENGINE_VERSION（${engineVersion}）不一致 —— `
  + '引擎版本升级必须同时升包版本，否则"报告可复现"这句话不成立')

/* ── ⑩′ 产物必须与源码同版（否则 verify 全绿，跑的还是旧代码）─────────────
 *
 * 真实事故（0.2.1）：源码改完、package.json 升到 0.2.1、`npm run verify` 全绿，
 * 但用户只跑了 verify（没跑 build），`lib/` 里躺的还是 0.2.0 的产物。
 * DSH 重启后加载的仍是旧代码 —— 四个刚修的缺陷原样复现，而校验一路绿灯。
 *
 * 根因：上面几条断言读的都是 `plugin-src/`，**没有任何一条看 `lib/`**。
 * 于是"源码是新的、产物是旧的"这个状态，恰好是校验完全看不见的状态。
 * 而它恰恰是最容易发生的状态：改完源码顺手 verify，忘了 build。
 *
 * 这条断言把"记得先 build"从人的自觉变成机器的检查。
 */
const builtAudit = await readIfExists('lib/audit.mjs')
check(builtAudit !== undefined,
  'lib/audit.mjs 不存在 —— 没有构建产物。先跑 `npm run build`')
const builtEngineVersion = /ENGINE_VERSION\s*=\s*['"]([^'"]+)['"]/u.exec(builtAudit ?? '')?.[1]
check(builtEngineVersion === engineVersion,
  `lib/ 是旧产物：产物里 ENGINE_VERSION = ${builtEngineVersion ?? '(缺失)'}，`
  + `而源码是 ${engineVersion} —— 说明改完源码**没有重新 build**。`
  + ' 此时 DSH 加载的仍是旧代码，源码里修的东西一行都不会生效。'
  + ' 处置：`npm run build` 之后**再重启 DSH**（顺序不能反：先重启后 build，重启加载的还是旧产物）。')

const readme = await readIfExists('README.md')
check(readme === undefined || readme.includes('AI垃圾过滤'),
  'README.md 未出现插件中文名「AI垃圾过滤」—— 用户装完在设置里找不到对应项')

/* ── ⑪ 测试清单与磁盘一致 ───────────────────────────────────────────── */
// 为什么需要这条：`test` 脚本里是**显式文件清单**（不用 glob，避免 Node 版本差异与
// "把 fixture 当测试跑"的问题）。显式清单的代价是"新增测试忘了加进脚本，它会静默不跑"。
// 这条断言就是那个代价的对冲：磁盘上有、脚本里没有 ⇒ 直接红。
const testScript = manifest.scripts?.test ?? ''
const listed = [...testScript.matchAll(/(?:^|\s)(test\/[^\s'"]+\.test\.mjs)/gu)].map(match => match[1]).sort()
const onDisk = (await readdir(resolve(ROOT, 'test')).catch(() => []))
  .filter(name => name.endsWith('.test.mjs'))
  .map(name => `test/${name}`)
  .sort()
check(listed.length > 0, 'package.json 的 test 脚本没有列出任何 test/*.test.mjs —— 测试不会执行')
check(JSON.stringify(listed) === JSON.stringify(onDisk),
  `test 脚本与磁盘上的测试文件不一致：\n    脚本：${listed.join(', ') || '(空)'}\n    磁盘：${onDisk.join(', ') || '(空)'}\n`
  + '  → 新增测试必须同时加进 package.json 的 test 脚本，否则它会静默不跑')

/* ── ⑫ 零联网承诺 ───────────────────────────────────────────────────── */
const HOST_FILES = HOST_SOURCES.map(name => `plugin-src/host/${name}`).concat('plugin-src/client/impl.mjs')
const NETWORK_PATTERNS = [
  { pattern: /\bfetch\s*\(\s*['"`]https?:/u, label: '直接请求外部 URL' },
  { pattern: /require\(['"]node:(?:https?|net|tls)['"]\)/u, label: '引入网络模块' },
  { pattern: /from ['"]node:(?:https?|net|tls|dgram)['"]/u, label: '引入网络模块' },
]
for (const relativePath of HOST_FILES) {
  const text = await readIfExists(relativePath)
  if (text === undefined) continue
  for (const { pattern, label } of NETWORK_PATTERNS) {
    if (pattern.test(text)) {
      failures.push(`${relativePath} 命中「${label}」—— 本插件承诺零联网；`
        + '若确需联网，请先撤回 README 里的离线声明，并补数据出境说明')
    }
  }
}

/* ── 汇总 ───────────────────────────────────────────────────────────── */
if (failures.length > 0) {
  console.error(`✗ 发布契约校验失败（${failures.length} 项）：\n`)
  for (const message of failures) console.error(`  · ${message}`)
  console.error('\n十三类断言：必需文件 / 依赖禁则 / 零运行时依赖 / 装载器 id / 面板契约 / 产物无 ESM / '
    + 'RPC 端点一致 / 敏感信息 + 内部词汇 / 发布白名单自洽 / 版本一致 / 产物与源码同版 / 测试清单一致 / 零联网')
  process.exit(1)
}

console.log('✓ 发布契约校验通过')
console.log('  必需文件 · 依赖禁则 · 零运行时依赖 · 装载器 id · 面板契约（settings.section / order 23 / AI垃圾过滤）')
console.log('  产物无 ESM 语法 · RPC 端点三处一致 · 敏感信息 + 内部词汇 · 发布白名单自洽 · 版本一致 · 产物与源码同版 · 测试清单一致 · 零联网')
