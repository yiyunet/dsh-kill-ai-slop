/**
 * 前置条件体检 —— `npm run doctor`。
 * 只读，不改任何东西。目的是让"为什么装不上/跑不起来"有一个明确的下一步，
 * 而不是让人对着一段栈去猜。
 */
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const problems = []
const notes = []

const nodeMajor = Number(process.versions.node.split('.')[0])
const nodeMinor = Number(process.versions.node.split('.')[1])
const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19)
if (!nodeOk) {
  problems.push(`Node ${process.versions.node} 低于要求（>=22.19）。`
    + '本插件用到 node:zlib 的同步解压与 TextDecoder 的 gbk 支持，低版本会静默降级。')
} else {
  notes.push(`Node ${process.versions.node} ✓`)
}

try {
  const decoder = new TextDecoder('gbk')
  notes.push(`GBK 解码可用 ✓（${decoder.encoding}）—— 老版中文 Office/文本不会变成乱码`)
} catch {
  notes.push('GBK 解码不可用（Node 未带完整 ICU）—— 非 UTF-8 中文文件可能乱码；不影响 UTF-8 文件')
}

const manifest = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
notes.push(`包：${manifest.name}@${manifest.version}`)

const SOURCES = [
  'plugin-src/host/index.mjs',
  'plugin-src/host/audit.mjs',
  'plugin-src/host/parse.mjs',
  'plugin-src/host/rules.mjs',
  'plugin-src/host/score.mjs',
  'plugin-src/host/layers.mjs',
  'plugin-src/host/rubric.mjs',
  'plugin-src/host/review.mjs',
  'plugin-src/host/reviewer.mjs',
  'plugin-src/host/advice.mjs',
  'plugin-src/host/distill.mjs',
  'plugin-src/host/text.mjs',
  'plugin-src/host/rpc.mjs',
  'plugin-src/client/index.mjs',
  'plugin-src/client/impl.mjs',
  'cordis.patch.yml',
]
for (const relativePath of SOURCES) {
  const info = await stat(resolve(ROOT, relativePath)).catch(() => undefined)
  if (info?.isFile() !== true) problems.push(`源文件缺失：${relativePath}`)
}

// 产物缺失**不算问题**：doctor 是"构建之前"就该能跑通的第一条命令。
// 早期版本把它当问题、exit 1，结果是"体检报告说你有病，而病就是还没体检"。
// 现在它只提示，真正把关的是 verify（发布门禁）。
const warnings = []
for (const relativePath of ['lib/index.mjs', 'lib/client.js']) {
  const info = await stat(resolve(ROOT, relativePath)).catch(() => undefined)
  if (info?.isFile() !== true) {
    warnings.push(`尚未构建：${relativePath} 不存在 → 跑 \`npm run build\``)
    continue
  }
  if (info.size === 0) {
    problems.push(`产物为空：${relativePath} → 跑 \`npm run build\``)
    continue
  }
  notes.push(`产物：${relativePath}（${(info.size / 1024).toFixed(1)} KB）`)
}

const deps = Object.keys(manifest.dependencies ?? {})
if (deps.length > 0) problems.push(`dependencies 非空（${deps.join(', ')}）—— 本插件承诺零运行时依赖`)
else notes.push('运行时依赖：0 ✓（离线、可审计）')

const buildDeps = Object.keys(manifest.devDependencies ?? {})
notes.push(buildDeps.length === 0
  ? '构建依赖：0 ✓（不用打包器，node 直接跑 scripts/build.mjs）'
  : `构建依赖：${buildDeps.join(', ')}`)

console.log('── 依赖与运行环境 ──')
for (const note of notes) console.log(`  · ${note}`)

if (warnings.length > 0) {
  console.log('\n── 提示（不阻断）──')
  for (const warning of warnings) console.log(`  · ${warning}`)
}

if (problems.length > 0) {
  console.error(`\n✗ 发现 ${problems.length} 个问题：\n`)
  for (const problem of problems) console.error(`  · ${problem}`)
  console.error('\n处理顺序：补文件 → npm run build → npm test → npm run verify')
  process.exit(1)
}

console.log(warnings.length > 0
  ? '\n✓ 源码与运行环境就绪（产物尚未构建）。下一步：npm run build'
  : '\n✓ 前置条件就绪，产物已在。下一步：npm test && npm run verify')
