/**
 * 客户端装载器 wrapper —— 真源。
 *
 * 构建时 scripts/build.mjs 把 plugin-src/client/impl.mjs 插到 __DSH_CLIENT_IMPL__ 处，
 * **插在 factory 函数体内部**。
 *
 * 为什么必须在 factory 内部：impl.mjs 里会用到 React，而 DSH 的 React 是通过
 * factory 的参数 `require` 在**运行时**解析的。放到 factory 外面就会在脚本顶层执行，
 * 拿到的是 undefined —— 整个 /plugins 拼接 bundle 会因此全灭，
 * 而报错会出现在别的插件上（例如 client-connection 未注册），极难归因。
 *
 * 平台冻结模块表只提供 react / react-dom / react/jsx-runtime / react-dom/client。
 */
window.__ModuleLoader__.load({
  id: '@yiyunet/dsh-kill-ai-slop',
  factory: require => {
    /**
 * 设置面板实现 ——「AI垃圾过滤 / Kill AI Slop」。
 *
 * ★ 本文件是**工厂函数**，不是可直接执行的模块：
 *   createClientPlugin(React) 由 lib/client.js 里的 wrapper 调用，React 由平台的
 *   冻结模块表通过 factory 的 require 提供。因此这里不写 import，只接参数。
 *   构建脚本会把顶层的 `export ` 去掉后原样嵌入 factory 内部（见 scripts/build.mjs）。
 *
 * ★ 面板只做三件事：选文件 → 看报告 → 复制/保存。
 *   判定逻辑**全在宿主半侧**：浏览器这一侧没有规则、没有权重、不解析文件。
 *   这样"分数怎么算的"只有一个真源，改规则不用两边同步。
 */

function createClientPlugin(React) {
  const h = React.createElement
  const { useCallback, useEffect, useMemo, useRef, useState } = React

  /** RPC 端点名 —— 必须与宿主 plugin-src/host/rpc.mjs 的 RPC_ENDPOINT 完全一致。 */
  const RPC_ENDPOINT = 'dsh-kill-ai-slop'

  /** 面板挂载 id / 显示名。order 23 —— 须大于既有面板的排序号，否则会排到前面。 */
  const PANEL_ID = 'dsh-kill-ai-slop'
  const PANEL_LABEL = 'AI垃圾过滤'
  const PANEL_LABEL_EN = 'Kill AI Slop'

  /** 仓库地址 —— 面板标题右侧的 GitHub 入口。改仓库只改这一处。 */
  const REPO_URL = 'https://github.com/yiyunet/dsh-kill-ai-slop'

  /**
   * 四层在**面板**里的兜底顺序：表达 → 策略 → 执行 → 意图。
   *
   * ★ 真源不在这里。宿主的 `layers.mjs` 的 `DISPLAY_ORDER` 才是，面板通过
   *   `status.layers.displayOrder` 读它（见 Panel 里的 `panelOrder`）。
   *   这个常量只在 status 还没回来时兜底用 —— 否则又会出现"同一份结果两个排法"。
   *   模型自身的推理链顺序（意图→策略→执行→表达）是另一件事，见 `LAYER_ORDER`。
   */
  const PANEL_LAYER_ORDER = ['expression', 'strategy', 'execution', 'intent']

  /** 层 id → 中文短名。宿主没下发定义时的兜底。 */
  const LAYER_SHORT = { intent: '意图', strategy: '策略', execution: '执行', expression: '表达' }

  /** 格子的取值选项 —— 面板「十二格评分」用。 */
  const CELL_CHOICES = [
    { value: '', label: '未评' },
    { value: '4', label: '4 本阶段已完成' },
    { value: '3', label: '3 局部补充' },
    { value: '2', label: '2 关键工作待补' },
    { value: '1', label: '1 材料与方向' },
    { value: '0', label: '0 未形成有效成果' },
    { value: 'und', label: '待确认（不填 0 也不填满分）' },
    { value: 'na', label: '不适用' },
  ]

  const S = {
    wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.65, color: 'inherit' },
    head: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 },
    title: { fontSize: 16, fontWeight: 700 },
    titleEn: { fontSize: 12, opacity: 0.55, letterSpacing: '0.02em' },
    version: { marginLeft: 'auto', fontSize: 11, opacity: 0.5, fontFamily: 'ui-monospace, monospace' },
    note: { fontSize: 11.5, opacity: 0.62, marginBottom: 10, lineHeight: 1.6 },
    tabs: { display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' },
    // ★ 实测：面板窄的时候按钮里的中文会**逐字竖排**（「保存报/告」「十二格评/分」），
    //   七个按钮各长成两三种高度，工具栏看着像被砸过。
    //   两条一起改：① 文案本身缩短（老板指定）；② 一律 nowrap + 容器允许换行，
    //   于是窄屏是「整颗按钮换到下一行」，而不是把按钮压扁。
    tab: {
      padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
      border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
      whiteSpace: 'nowrap',
    },
    tabActive: {
      padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
      border: '1px solid rgba(120,160,255,0.9)', background: 'rgba(120,160,255,0.16)', color: 'inherit', fontWeight: 600,
      whiteSpace: 'nowrap',
    },
    drop: {
      border: '1.5px dashed rgba(127,127,127,0.45)', borderRadius: 10, padding: '22px 16px',
      textAlign: 'center', cursor: 'pointer', transition: 'border-color .15s, background .15s',
    },
    dropActive: {
      border: '1.5px dashed rgba(120,160,255,0.95)', borderRadius: 10, padding: '22px 16px',
      textAlign: 'center', cursor: 'pointer', background: 'rgba(120,160,255,0.10)',
    },
    dropMain: { fontSize: 13, marginBottom: 4 },
    dropHint: { fontSize: 11.5, opacity: 0.6 },
    area: {
      width: '100%', minHeight: 150, padding: 10, borderRadius: 8, fontSize: 12.5,
      border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
      boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6,
    },
    row: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 },
    field: { display: 'flex', flexDirection: 'column', gap: 3 },
    label: { fontSize: 11, opacity: 0.6 },
    select: {
      padding: '5px 8px', borderRadius: 6, fontSize: 12.5, minWidth: 130,
      border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
    },
    btn: {
      padding: '6px 14px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer',
      border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit',
      whiteSpace: 'nowrap',
    },
    btnPrimary: {
      padding: '6px 16px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer', fontWeight: 600,
      border: '1px solid rgba(120,160,255,0.95)', background: 'rgba(120,160,255,0.22)', color: 'inherit',
    },
    btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
    card: {
      border: '1px solid rgba(127,127,127,0.28)', borderRadius: 10, padding: '12px 14px', marginTop: 12,
    },
    err: {
      border: '1px solid rgba(255,110,110,0.6)', borderRadius: 8, padding: '10px 12px',
      background: 'rgba(255,110,110,0.10)', marginTop: 10, fontSize: 12.5,
    },
    headline: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
    bigNum: { fontSize: 34, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums' },
    band: { fontSize: 13, fontWeight: 600 },
    muted: { fontSize: 11.5, opacity: 0.6 },
    barTrack: { height: 7, borderRadius: 4, background: 'rgba(127,127,127,0.22)', overflow: 'hidden', marginTop: 5 },
    barFill: { height: '100%', borderRadius: 4, transition: 'width .25s' },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 },
    th: { textAlign: 'left', padding: '5px 6px', borderBottom: '1px solid rgba(127,127,127,0.3)', fontWeight: 600, fontSize: 11.5, opacity: 0.75, whiteSpace: 'nowrap', verticalAlign: 'middle' },
    td: { padding: '5px 6px', borderBottom: '1px solid rgba(127,127,127,0.14)', verticalAlign: 'top' },
    hit: {
      border: '1px solid rgba(127,127,127,0.2)', borderRadius: 8, padding: '8px 10px', marginTop: 8,
      background: 'rgba(127,127,127,0.05)', fontSize: 12,
    },
    snippet: {
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5,
      padding: '3px 6px', borderRadius: 4, background: 'rgba(127,127,127,0.14)',
      display: 'block', margin: '3px 0 5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    },
    k: { opacity: 0.62, fontSize: 11.5 },
    quote: {
      borderLeft: '3px solid rgba(120,160,255,0.7)', paddingLeft: 10, margin: '6px 0',
      fontSize: 12.5, lineHeight: 1.65,
    },
    tag: {
      display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 10.5,
      border: '1px solid rgba(127,127,127,0.35)', marginRight: 5,
    },
    pre: {
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11.5,
      background: 'rgba(127,127,127,0.10)', padding: 10, borderRadius: 8,
      maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0 0',
    },
    secTitle: { fontSize: 13, fontWeight: 700, margin: '14px 0 6px' },
    list: { margin: '4px 0 0', paddingLeft: 18 },
  }

  const fmtBytes = bytes => {
    if (!Number.isFinite(bytes)) return '—'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  /** 文件 → base64（分块，避免超长参数栈溢出）。 */
  async function fileToBase64(file) {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunk = 0x8000
    for (let at = 0; at < bytes.length; at += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(at, at + chunk))
    }
    return btoa(binary)
  }

  const severityColor = severity => {
    if (severity >= 3) return 'rgba(255,110,110,0.85)'
    if (severity === 2) return 'rgba(255,180,80,0.85)'
    if (severity === 1) return 'rgba(120,200,140,0.8)'
    return 'rgba(127,127,127,0.4)'
  }

  /** 评审模型选择在 localStorage 里的键（面板专属，不与会话选择共享）。 */
  const MODEL_KEY = 'dsh-kill-ai-slop.review-model'

  function Panel(props) {
    const rpc = props.rpc
    const [status, setStatus] = useState(null)
    const [statusError, setStatusError] = useState('')
    const [tab, setTab] = useState('upload')
    const [file, setFile] = useState(null)
    const [pasted, setPasted] = useState('')
    const [dragActive, setDragActive] = useState(false)
    const [docType, setDocType] = useState('auto')
    const [level, setLevel] = useState('summary')
    const [busy, setBusy] = useState('')
    const [error, setError] = useState(null)
    const [report, setReport] = useState(null)
    const [view, setView] = useState('overview')
    const [openDim, setOpenDim] = useState({})
    const [copied, setCopied] = useState('')
    const [recent, setRecent] = useState([])
    const [layersView, setLayersView] = useState(null)   // 面板试算出的四层结果（覆盖 report.layers）
    const [cellDraft, setCellDraft] = useState({})       // { [cellId]: '4'|'3'|…|'und'|'na'|'' }
    // 「生成评审」产出的原始评审记录。作用：让**两个按钮不再互相覆盖**。
    // 先评审再体检时把它带上，服务端用 docId 判是不是同一版原文。
    const [lastReview, setLastReview] = useState(null)   // null | { filename, review }
    // 评审模型：'provider|model'，空串 = 交给服务端取第一个可用模型。
    // 选择记在 localStorage —— 换一次面板不用重选。
    const [modelChoice, setModelChoice] = useState(() => {
      try { return window.localStorage.getItem(MODEL_KEY) ?? '' } catch { return '' }
    })
    const [modelCatalog, setModelCatalog] = useState(null)  // null | [{ id, name, models:[{id,name}] }]
    const inputRef = useRef(null)

    useEffect(() => {
      let alive = true
      Promise.resolve(rpc('status', {}))
        .then(result => {
          if (!alive) return
          if (result && result.ok === false) setStatusError(result.error?.message ?? '状态读取失败')
          else setStatus(result ?? null)
        })
        .catch(cause => { if (alive) setStatusError(String(cause?.message ?? cause)) })
      return () => { alive = false }
    }, [rpc])

    const refreshRecent = useCallback(() => {
      Promise.resolve(rpc('recent', {}))
        .then(result => { if (result?.ok !== false) setRecent(result.items ?? []) })
        .catch(() => {})
    }, [rpc])

    useEffect(() => { refreshRecent() }, [refreshRecent])

    // 最近报告都是内存里的完整对象，点一下就能重新打开 —— 列表若只显示不能点，等于摆设。
    const openRecent = useCallback(index => {
      Promise.resolve(rpc('recentGet', { index }))
        .then(result => {
          if (result?.ok === false || result?.report === undefined) {
            setError({
              message: result?.error?.message ?? '这份报告已经不在内存里了。',
              hint: 'DSH 重启或超出保留条数后，内存里的报告会被清掉。',
            })
            return
          }
          setError(null)
          setReport(result.report)
          // 换了报告就丢掉上一份的试算结果，否则四层卡会显示错文件的分数。
          setLayersView(null)
          setCellDraft({})
          setView('overview')
          setOpenDim({})
        })
        .catch(cause => setError({ message: String(cause?.message ?? cause) }))
    }, [rpc])

    const limits = status?.limits ?? {}
    const maxBytes = Number(limits.maxRpcBytes ?? limits.maxFileBytes ?? 12 * 1024 * 1024)

    /**
     * 面板四层顺序：**优先读宿主下发的 `displayOrder`**，常量只作兜底。
     * 顺序的真源在宿主 `layers.mjs` 的 DISPLAY_ORDER —— 报告 §〇、面板、引擎自检三处读同一份。
     * 客户端自己留一份常量是为了 status 还没回来时也能渲染，不是第二真源。
     */
    const panelOrder = status?.layers?.displayOrder ?? PANEL_LAYER_ORDER

    const pickFile = useCallback(candidate => {
      if (candidate === null || candidate === undefined) return
      setError(null)
      if (candidate.size > maxBytes) {
        setFile(null)
        setError({
          message: `文件 ${fmtBytes(candidate.size)} 超过面板上传上限 ${fmtBytes(maxBytes)}。`,
          hint: '换更小的文件，或让宿主侧配置调大 maxRpcBytes。',
        })
        return
      }
      setFile(candidate)
    }, [maxBytes])

    /**
     * 拉模型清单 —— 只在宿主确实有 llm 服务时拉。
     * ★ 这份清单是**面板自己的**，与会话框右下角那个选择器无关：
     *   那个是 `conversation.input.model` 槽位的组件、读的是会话投影，
     *   而这里是 settings.section 槽位，没有会话上下文。两者不共享选择。
     */
    useEffect(() => {
      if (status?.llm?.available !== true) return undefined
      let alive = true
      Promise.resolve(rpc('models', {}))
        .then(result => {
          if (!alive || result?.ok !== true) return
          const providers = Array.isArray(result.providers) ? result.providers : []
          setModelCatalog(providers.filter(item => Array.isArray(item.models) && item.models.length > 0))
        })
        .catch(() => { /* 拉不到就退回"默认模型"，不打断体检 */ })
      return () => { alive = false }
    }, [status?.llm?.available])

    /** 摊平成下拉选项：'provider|model' → 'Provider · Model'。 */
    const modelOptions = (modelCatalog ?? []).flatMap(provider => provider.models.map(model => ({
      value: `${provider.id}|${model.id}`,
      label: `${provider.name || provider.id} · ${model.name || model.id}`,
    })))

    /**
     * 复用上一次评审 —— 只在**同一份文件**上复用。
     * 换了文件就丢掉：拿旧判定给新文件打分是最坏的一种错；
     * 服务端还有 docId 闸门兜底，但那种报错对用户没意义，先在这里挡住。
     */
    function carriedReview(filename) {
      if (lastReview === null || lastReview.filename !== filename) return {}
      return { review: lastReview.review }
    }

    /**
     * ★ 0.7.9：面板只留一个「开始体检」。
     *
     *   原来两个按钮（生成评审 → 开始体检），但「生成评审」那一步**已经出了完整报告**
     *   （服务端 reviewPoll 返回的就是 report），第二步对新文件没有新的材料输入 ——
     *   用户看到的是"点了一次、什么都没多出来、还要再点一次"。
     *
     *   现在：一个按钮 —— 没有可用评审就先通读（通读本身出报告），
     *   有可用的（同一文件 + 0–10 刻度）就直接算，不白烧一遍 token。
     *   想强制重评，用旁边的「重新通读」。
     */
    function hasUsableReview(filename) {
      const carried = carriedReview(filename).review
      if (carried === undefined || carried === null || Number(carried.scoreScale) !== 10) return false
      // ★ 0.7.11：声明也是评审的输入。改了文档类型或期望产出，旧判定就不再成立 ——
      //   必须重新通读，否则模型看不到新声明，用户会以为"我改了啊，怎么分没变"。
      return lastReview.docType === docType && lastReview.level === level
    }

    /** 评审被拒（换了原文 / 旧刻度）→ 自动重新通读一次，而不是把报错丢给用户。 */
    function needsReReview(result) {
      const code = result?.report?.layers?.review?.code
      return code === 'stale-review' || code === 'scale-mismatch'
    }

    async function runCheck() {
      const name = tab === 'upload' ? (file === null ? null : file.name) : '粘贴文本.txt'
      const canRunModel = status?.llm?.available === true
      // 没有文件 → 交给 runAudit 去报"请先选择或拖入一个文件"（它那条提示更准）
      if (name === null || canRunModel !== true || hasUsableReview(name)) {
        await runAudit()
        return
      }
      await runReview()
    }

    async function runAudit() {
      setError(null)
      setCopied('')
      try {
        if (tab === 'upload') {
          if (file === null) {
            setError({ message: '请先选择或拖入一个文件。', hint: '支持 docx / docm / pptx / xlsx / odt / ods / odp / pdf / txt / md / csv / json / html。' })
            return
          }
          setBusy('正在解析并体检…')
          const base64 = await fileToBase64(file)
          const result = await rpc('audit', { filename: file.name, base64, docType, level, ...carriedReview(file.name) })
          if (result?.ok === false) {
            setError({ message: result.error?.message ?? '体检失败', hint: result.error?.details?.hint })
            setReport(null)
            return
          }
          // 复用的评审被服务端拒了（原文改了 / 旧 0–4 刻度）→ 自动重新通读，别让用户对着报错猜。
          if (needsReReview(result)) { await runReview(); return }
          setReport(result.report)
          // 换了报告就丢掉上一份的试算结果，否则四层卡会显示错文件的分数。
          setLayersView(null)
          setCellDraft({})
          setView('overview')
          refreshRecent()
        } else {
          if (pasted.trim() === '') {
            setError({ message: '请先粘贴要分析的文本。', hint: '粘贴原文，不要粘贴已经总结过的版本。' })
            return
          }
          setBusy('正在体检…')
          const result = await rpc('auditText', { text: pasted, filename: '粘贴文本.txt', docType, level, ...carriedReview('粘贴文本.txt') })
          if (result?.ok === false) {
            setError({ message: result.error?.message ?? '体检失败', hint: result.error?.details?.hint })
            setReport(null)
            return
          }
          // 复用的评审被服务端拒了（原文改了 / 旧 0–4 刻度）→ 自动重新通读，别让用户对着报错猜。
          if (needsReReview(result)) { await runReview(); return }
          setReport(result.report)
          // 换了报告就丢掉上一份的试算结果，否则四层卡会显示错文件的分数。
          setLayersView(null)
          setCellDraft({})
          setView('overview')
          refreshRecent()
        }
      } catch (cause) {
        setError({ message: String(cause?.message ?? cause) })
      } finally {
        setBusy('')
      }
    }

    async function copyMarkdown() {
      if (report === null) return
      try {
        await navigator.clipboard.writeText(report.markdown ?? '')
        setCopied('已复制 Markdown 报告到剪贴板。')
      } catch (cause) {
        setCopied(`复制失败：${cause?.message ?? cause}（可切到「Markdown」页手动全选复制）`)
      }
    }

    /** 兜底保存：交给浏览器下载。落点由浏览器决定（Chrome / Edge 可设为"每次询问"）。 */
    function downloadReport(markdown, suggestedName) {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = suggestedName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      setCopied(`已交给浏览器下载：${suggestedName}（若没弹出位置选择，可在浏览器设置里开启「每次询问保存位置」）`)
    }

    /**
     * 保存报告 —— 由**使用者选择保存位置**。
     *
     * 早先这里走宿主落盘：必须先在 profile 里配好 reportRoot，否则点一下就报错。
     * 那是设计错误，不是功能缺陷 ——「保存一个刚生成的文件」是最基础的动作，
     * 不该以"先改配置文件、再重启 Host"为前提。实测就是这么被绊住的。
     *
     * 改法：在浏览器侧直接写盘。showSaveFilePicker 会弹原生「另存为」对话框，
     * 落点完全由使用者决定；宿主一个字节都不落盘，也就不需要任何配置与写权限。
     * 不支持的浏览器（Firefox / Safari / 被策略禁用）退回下载，仍然**不报错**。
     */
    async function saveReport() {
      if (report === null) return
      setCopied('')
      setError(null)
      const markdown = report.markdown ?? ''
      // 文件名 = 原文件名 + 固定后缀。**不叠时间戳**。
      //   早先是 `2026-10-19-04-02-51-<原名>-体检报告.md`，那段数字有两个毛病：
      //   ① `04-02-51` 是 UTC 时刻（本地 12:02:51 时它写 04-02-51），与你的钟差 8 小时，读不懂；
      //   ② `年-月-日-` 这种前缀是内部文档「日期-主题」的命名习惯，不该外溢到使用者自己的文件上。
      //   存哪里、要不要改名，在保存对话框里当场定 —— 这里只给一个好认的默认值。
      const stem = String(report.filename ?? '').replace(/\.[^.]+$/u, '').trim()
      const suggestedName = stem === '' ? '文件体检报告.md' : `${stem}-体检报告.md`
      const picker = typeof window === 'undefined' ? undefined : window.showSaveFilePicker
      if (typeof picker === 'function') {
        try {
          const handle = await picker.call(window, {
            suggestedName,
            types: [{ description: 'Markdown 文本', accept: { 'text/markdown': ['.md'] } }],
          })
          const writable = await handle.createWritable()
          await writable.write(markdown)
          await writable.close()
          setCopied(`已保存到：${handle.name}`)
          return
        } catch (cause) {
          // 用户按「取消」不是错误；其它原因（策略禁用、非安全上下文）退回下载，也不打断他。
          if (cause?.name === 'AbortError') return
          downloadReport(markdown, suggestedName)
          return
        }
      }
      downloadReport(markdown, suggestedName)
    }

    /**
     * 在面板里生成一次评审：启动后台任务 → 轮询 → 拿报告。
     *
     * ★ 为什么面板需要这条路：面板的调用方是**用户**，不是模型。
     *   v0.7 的「必须有 review」只有模型能满足 —— 于是面板永远 0/12。
     *   这里把"用户去会话里叫一遍模型"换成"一个按钮"，
     *   但判定仍由模型通读给出、引文仍要过校验，引擎一个字都没少核。
     */
    async function runReview() {
      setError(null)
      setCopied('')
      let payload
      try {
        if (tab === 'upload') {
          if (file === null) {
            setError({ message: '请先选择或拖入一个文件。', hint: '支持 docx / docm / pptx / xlsx / odt / ods / odp / pdf / txt / md / csv / json / html。' })
            return
          }
          payload = { filename: file.name, base64: await fileToBase64(file), docType, level }
        } else {
          if (pasted.trim() === '') {
            setError({ message: '请先粘贴要分析的文本。', hint: '粘贴原文，不要粘贴已经总结过的版本。' })
            return
          }
          payload = { filename: '粘贴文本.txt', text: pasted, docType, level }
        }
      } catch (cause) {
        setError({ message: `读取文件失败：${cause?.message ?? cause}` })
        return
      }

      // 面板选过模型就带上；没选就让服务端取第一个可用模型（不猜、不写死）。
      if (modelChoice !== '') {
        const [pickedProvider, pickedModel] = modelChoice.split('|')
        if (pickedProvider !== undefined && pickedModel !== undefined) {
          payload.provider = pickedProvider
          payload.model = pickedModel
        }
      }

      setBusy('正在通读全文…')
      try {
        const started = await rpc('reviewStart', payload)
        if (started?.ok === false) {
          setError({ message: started.error?.message ?? '评审启动失败', hint: started.error?.details?.hint })
          return
        }
        // 轮询：每 1.5 秒问一次。一次评审通常 30–90 秒。
        for (;;) {
          await new Promise(resolve => { setTimeout(resolve, 1500) })
          const polled = await rpc('reviewPoll', { jobId: started.jobId })
          if (polled?.ok === false) {
            setError({ message: polled.error?.message ?? '评审中断' })
            return
          }
          if (polled.state === 'running') {
            setBusy(`模型正在通读…已生成 ${polled.receivedChars ?? 0} 字`)
            continue
          }
          if (polled.state === 'done') {
            // 把原始评审记下来：之后点「开始体检」不会再把分数清空。
            if (polled.review !== undefined && polled.review !== null) {
              setLastReview({ filename: payload.filename, review: polled.review, docType: payload.docType, level: payload.level })
            }
            setReport(polled.report)
            setLayersView(null)
            setCellDraft({})
            setView('overview')
            refreshRecent()
            return
          }
          setError({ message: polled.error?.message ?? '评审失败', hint: polled.error?.details?.hint })
          return
        }
      } catch (cause) {
        setError({ message: `评审失败：${cause?.message ?? cause}` })
      } finally {
        setBusy('')
      }
    }

    /* ───────────────────────── 渲染片段 ───────────────────────── */

    function renderStatusLine() {
      if (statusError !== '') {
        return h('div', { style: S.err }, `面板状态读取失败：${statusError}。工具侧仍可用。`)
      }
      if (status === null) return h('div', { style: S.muted }, '读取引擎状态…')
      return h('div', { style: S.note },
        status.disclaimer,
        h('br', null),
        `引擎 ${status.engineVersion} · 规则集 ${status.ruleSetVersion} · 零联网、零上传、默认零落盘`)
    }

    function renderInput() {
      if (tab === 'paste') {
        return h('div', null,
          h('textarea', {
            style: S.area,
            value: pasted,
            placeholder: '把收到的文件内容粘贴到这里（原文，不要预先总结）。',
            onChange: event => setPasted(event.target.value),
          }),
          h('div', { style: S.row }, h('span', { style: S.muted }, `${pasted.length} 字符`)),
        )
      }
      return h('div', null,
        h('div', {
          style: dragActive ? S.dropActive : S.drop,
          onClick: () => inputRef.current?.click(),
          onDragOver: event => { event.preventDefault(); setDragActive(true) },
          onDragLeave: () => setDragActive(false),
          onDrop: event => {
            event.preventDefault()
            setDragActive(false)
            const dropped = event.dataTransfer?.files?.[0]
            if (dropped !== undefined) pickFile(dropped)
          },
        },
          h('div', { style: S.dropMain }, file === null ? '拖入文件，或点击选择' : `已选择：${file.name}`),
          h('div', { style: S.dropHint },
            file === null
              ? `支持 docx / pptx / xlsx / odt / ods / odp / pdf / txt / md / csv / json / html；扩展名写错也按内容读。上限 ${fmtBytes(maxBytes)}`
              : `${fmtBytes(file.size)} · 点此可重新选择`),
        ),
        h('input', {
          type: 'file',
          ref: inputRef,
          style: { display: 'none' },
          // .doc/.xls/.ppt 故意留在可选范围里：挡在文件选择器外面，用户只会看到"这个文件根本选不了"，
          // 而选进来我们能明确告诉他"这是旧版二进制，请另存为 .docx"。
          accept: '.txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.html,.htm,.rtf'
            + ',.docx,.docm,.dotx,.pptx,.pptm,.xlsx,.xlsm,.odt,.ods,.odp,.pdf'
            + ',.doc,.xls,.ppt',
          onChange: event => pickFile(event.target.files?.[0]),
        }),
      )
    }

    function renderControls() {
      const docTypes = status?.docTypes ?? [{ id: 'auto', label: '自动判断' }]
      const levels = status?.levels ?? [{ id: 'summary', label: '工作摘要' }]
      const llmReady = status?.llm?.available === true
      // 当前这份文件手上有没有可复用的评审（同一文件 + 0–10 刻度）
      const currentName = tab === 'upload' ? (file === null ? null : file.name) : '粘贴文本.txt'
      const canReuse = currentName !== null && hasUsableReview(currentName)
      return h('div', { style: S.row },
        h('div', { style: S.field },
          h('span', { style: S.label }, '文档类型'),
          h('select', {
            style: S.select,
            value: docType,
            title: '委托方对这份东西的定义。会随原文一起交给模型：纯记录类不承担论证义务、纯分析类不承诺执行，模型据此决定哪些检查点本来就不适用。',
            onChange: event => setDocType(event.target.value),
          },
          docTypes.map(item => h('option', { key: item.id, value: item.id }, item.label)))),
        h('div', { style: S.field },
          h('span', { style: S.label }, '期望产出'),
          h('select', {
            style: S.select,
            value: level,
            title: '你希望拿这份东西产出什么。既决定「提炼」页的粒度，也告诉模型这份东西是给谁、用来做什么的。',
            onChange: event => setLevel(event.target.value),
          },
          levels.map(item => h('option', { key: item.id, value: item.id }, item.label)))),
        llmReady && modelOptions.length > 0
          ? h('div', { style: S.field },
            h('span', { style: S.label }, '评审模型'),
            h('select', {
              style: S.select,
              value: modelChoice,
              title: '这是本面板自己的选择，与会话框右下角的模型选择互不影响。',
              onChange: event => {
                const value = event.target.value
                setModelChoice(value)
                try { window.localStorage.setItem(MODEL_KEY, value) } catch { /* 无痕模式等，忽略 */ }
              },
            },
            h('option', { value: '' }, '默认（第一个可用模型）'),
            modelOptions.map(item => h('option', { key: item.value, value: item.value }, item.label))))
          : null,
        h('div', { style: { flex: 1 } }),
        // ★ 0.7.9：两个按钮合成一个。评审那一步已经出了完整报告，
        //   再让用户点第二次「开始体检」等于让他等两遍同一个结果。
        canReuse && busy === ''
          ? h('button', {
            style: { background: 'transparent', border: 'none', color: 'rgba(120,160,255,0.95)', cursor: 'pointer', fontSize: 12, padding: '0 8px' },
            title: '丢掉上次的判定，重新让模型通读全文（约 30–90 秒）',
            onClick: runReview,
          }, '重新通读')
          : null,
        h('button', {
          style: busy === '' ? S.btnPrimary : Object.assign({}, S.btnPrimary, S.btnDisabled),
          disabled: busy !== '',
          title: llmReady
            ? (canReuse
              ? '用上次的评审直接算分并出报告；想重新判定请点左边的「重新通读」'
              : '让模型通读全文 → 核对引文 → 算分并出报告（约 30–90 秒）')
            : '宿主未提供 llm 服务：只能对已有评审算分。可在会话里走 slop_prepare → review 路径。',
          onClick: runCheck,
        }, busy === '' ? '开始体检' : busy),
      )
    }

    /* ───────────────── 四层十二格（0.5.x 主口径）───────────────── */

    /** 面板当前生效的四层结果：面板试算优先，否则用宿主返回的 report.layers。 */
    const effectiveLayers = () => layersView ?? report.layers ?? null

    const layerScoreText = layer => {
      if (layer === undefined) return '—'
      if (layer.value === null || layer.value === undefined) return '未评'
      return `${layer.display ?? Math.round(layer.value)}`
    }

    const layerColor = layer => {
      if (layer === undefined || layer.value === null || layer.value === undefined) return 'rgba(127,127,127,0.7)'
      const value = layer.display ?? layer.value
      return value >= 80 ? 'rgba(120,200,140,0.95)'
        : value >= 60 ? 'rgba(190,200,120,0.95)'
          : value >= 40 ? 'rgba(255,180,80,0.95)' : 'rgba(255,110,110,0.95)'
    }

    /**
     * 总览第一张卡：四层分数 + 推进结论。
     *
     * ★ 这是 0.5.x 的主口径，必须排在旧三指数**之前** ——
     *   否则读者第一眼看到的还是「体检得分 69」那个越高越差的数，
     *   与「越高越好」的四层分方向相反，等于同屏两套反义刻度。
     */
    function renderLayersCard() {
      const layers = effectiveLayers()
      if (layers === null) return null
      const defs = status?.layers?.definitions ?? []
      const defOf = id => defs.find(item => item.id === id)
      const byId = id => layers.layers?.find(item => item.id === id)
      const composite = layers.composite ?? {}
      const readiness = layers.readiness ?? {}
      const ordered = panelOrder.map(id => ({ id, layer: byId(id), def: defOf(id) }))
      const ratedCount = (layers.cells ?? []).filter(cell => cell.state === 'rated').length
      // ★ 0.7.13：首屏报**缺口数**，不是格数 —— 同一件事会同时在几格扣分。
      const shortfalls = layers.shortfalls ?? []
      const unfinished = (layers.cells ?? []).filter(cell => cell.state === 'rated' && typeof cell.score === 'number' && cell.score < 10)

      // ★ 0.7.2：没有任何判定时，不摆四张"未评"大卡。
      //   它们占首屏最大面积却永远是空的 —— 把"还没做"演示成了"结果"，
      //   下面还拖着一句把四层内部理由拼起来的天书。这里改成一个诚实的小卡。
      if (ratedCount === 0) {
        return h('div', { style: S.card },
          h('div', { style: S.secTitle }, '四层评审：还没有判定'),
          h('div', { style: S.muted }, '这份文件还没有被通读过，因此没有层分、没有综合分、没有推进结论。'),
          h('div', { style: Object.assign({}, S.muted, { marginTop: 8 }) },
            status?.llm?.available === true
              ? '点上面的「开始体检」：模型会通读全文、按 12 条规程打分，引文回原文逐字核对。'
              : '宿主未提供 llm 服务，无法在面板内生成评审；可在会话里走 slop_prepare → review 路径。'),
          h('div', { style: Object.assign({}, S.muted, { marginTop: 6 }) },
            '这不是"文件有问题"，也不是"文件没问题" —— 是还没人看过它。'),
        )
      }

      return h('div', { style: S.card }, [
        h('div', { key: 'head', style: S.headline },
          h('div', {
            key: 'composite',
            style: Object.assign({}, S.bigNum, {
              color: composite.display === null || composite.display === undefined
                ? 'rgba(127,127,127,0.7)' : 'rgba(120,160,255,0.95)',
            }),
          }, composite.display === null || composite.display === undefined ? '—' : composite.display),
          h('div', { key: 'meta', style: { flex: 1, minWidth: 200 } },
            h('div', { style: S.band }, '综合质量分 · 越高越好'),
            h('div', { style: Object.assign({}, S.muted, { marginTop: 3 }) },
              composite.withheld === true
                ? (composite.withheldReason ?? '本次不出综合分')
                : `权重 ${panelOrder
                  .map(id => `${LAYER_SHORT[id] ?? id} ${Math.round((layers.weights?.[id] ?? 0) * 100)}%`).join(' / ')}；初案未校准`),
            h('div', { style: Object.assign({}, S.muted, { fontSize: 11, marginTop: 2 }) },
              `已评 ${ratedCount} / 12 格`),
            h('div', { style: { fontSize: 11, marginTop: 2, color: (shortfalls.length > 0 || unfinished.length > 0) ? 'rgba(255,170,90,0.95)' : 'rgba(140,200,140,0.95)' } },
              shortfalls.length > 0
                ? `还有 ${shortfalls.length} 项工作没做完`
                : (unfinished.length === 0
                  ? '十二格里没有低于 10 分的格 —— 本阶段该做的做完了'
                  : `还有 ${unfinished.length} 个检查点没到满分`)),
          ),
        ),

        // 四层横排：表达 → 策略 → 执行 → 意图
        h('div', { key: 'layers', style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 } },
          ordered.map(item => {
            const layer = item.layer
            const label = LAYER_SHORT[item.id] ?? item.id
            return h('div', {
              key: item.id,
              style: {
                flex: '1 1 130px', minWidth: 130, padding: '9px 11px', borderRadius: 8,
                border: '1px solid rgba(127,127,127,0.26)', background: 'rgba(127,127,127,0.05)',
              },
            }, [
              h('div', { key: 'top', style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                h('span', { style: { fontWeight: 700, fontSize: 12.5 } }, label),
                h('span', { style: Object.assign({}, S.muted, { fontSize: 10.5 }) },
                  `权重 ${Math.round((layer?.weight ?? 0) * 100)}%`)),
              h('div', {
                key: 'value',
                style: { fontSize: 26, fontWeight: 800, lineHeight: 1.1, color: layerColor(layer), fontVariantNumeric: 'tabular-nums' },
              }, layerScoreText(layer)),
              // ★ 层分只由"已评格"平均出来，所以覆盖率必须当场说 ——
              //   一格已评、两格待确认也会印出一个像模像样的层分，不说清就成了另一种假精确。
              h('div', { key: 'cov', style: { fontSize: 10.5, opacity: 0.6, marginTop: 1 } },
                layer === undefined ? '' : `已评 ${layer.rated}/${layer.total} 格`),
              h('div', { key: 'q', style: Object.assign({}, S.muted, { fontSize: 10.5, marginTop: 2, lineHeight: 1.45 }) },
                item.def?.question ?? ''),
              layer?.hasCriticalGap === true
                ? h('div', { key: 'gap', style: { fontSize: 10.5, marginTop: 3, color: 'rgba(255,150,120,0.95)' } },
                  `含关键缺口 ${layer.criticalGapCells.join('、')}`)
                : null,
            ])
          }),
        ),

        // 推进结论：与分数并列，不能只放分
        h('div', { key: 'readiness', style: { marginTop: 12, fontSize: 12.5, lineHeight: 1.65 } },
          h('span', { style: { fontWeight: 700 } }, '推进结论：'),
          readiness.text ?? '—'),
        (readiness.canStartNow ?? []).length === 0
          ? null
          : h('div', { key: 'can', style: Object.assign({}, S.muted, { marginTop: 4, fontSize: 11.5 }) },
            `现在就能做：${readiness.canStartNow.join('；')}`),
        (readiness.mustWait ?? []).length === 0
          ? null
          : h('div', { key: 'wait', style: Object.assign({}, S.muted, { marginTop: 2, fontSize: 11.5 }) },
            `必须等：${readiness.mustWait.join('；')}`),
        (readiness.downgradedNote ?? '') === ''
          ? null
          : h('div', { key: 'dg', style: { marginTop: 4, fontSize: 11.5, color: 'rgba(255,180,80,0.95)' } },
            readiness.downgradedNote),

        // ★ 0.7.13：删掉「补上能涨 X 分」。那是"只补这一格、别的都不动"的数学情景，
        //   印在首屏只会把修订引向追分，而不是把活干完。缺口清单在下面的「证据」页。

        // ★ 0.6.0：分数由引擎自己给（机器评估），不再要求用户填表。
        layers.source === 'machine'
          ? h('div', { key: 'machine', style: Object.assign({}, S.muted, { marginTop: 10, lineHeight: 1.6 }) },
            `机器评估：只覆盖引擎真有证据的 ${layers.machineCellsRated ?? 0} / 12 格，`
            + '其余格标「待确认」，不猜。机器分只给 2–4 —— 判 0/1 等于是判决这份交付无效，'
            + '那必须有归属与四条件依据。逐格依据见「证据」页。')
          : null,
        ratedCount === 0
          ? h('div', { key: 'empty', style: Object.assign({}, S.muted, { marginTop: 6, lineHeight: 1.6 }) },
            '十二格全部未评 —— 这份文件没有可支撑任何一格的证据。')
          : null,
        composite.weightDiscrimination === false
          ? h('div', { key: 'same', style: Object.assign({}, S.muted, { marginTop: 6, fontSize: 11.5 }) },
            '⚠️ 四层同分，权重本次未产生区分 —— 综合分的排序意义有限，看层内哪一格低。')
          : null,
      ])
    }

    /**
     * 证据页第一张卡：十二格逐格证据。
     *
     * ★ 旧证据页只摊开了执行（C）与决策（D），表达由逐维表覆盖，**意图整块缺失**。
     *   而四层里最该被问的恰恰是意图（接住了什么任务）。
     *   这里按同一套层顺序把 12 格全摊开：分数、状态、归属、判定理由、证据线索。
     */
    function renderCellEvidence() {
      const layers = effectiveLayers()
      if (layers === null) return null
      const cells = layers.cells ?? []
      if (cells.length === 0) return null
      const hints = layers.hints ?? report.layers?.hints ?? {}

      const stateLabel = cell => (cell.state === 'rated' ? '已评'
        : cell.state === 'undetermined' ? '待确认'
          : cell.state === 'not-applicable' ? '不适用' : '未评')

      // ★ 改成「块」而不是「表格行」。
      //   实测：七列在窄面板里，`table-layout: fixed` 把「判定」挤成一列一字
      //   （渲染成"未/评/：/0/–/4"竖排），表头「判定 / 为什么没分」和「证据线索」叠在一起。
      //   块布局没有列宽可挤：宽度够就一行，不够就自然换行。
      const cellRow = cell => {
        const judged = cell.state === 'rated'
          ? (cell.note === '' ? '—' : cell.note)
          : (cell.state === 'undetermined'
            // ★ 0.7.15：这里原来印的是「把原文那一句复制过来就能按原判给分」——
            //   那是写给提交者的修复指引，放在「证据」页等于拿操作说明冒充证据。
            //   证据页只回答一件事：这一格为什么没分。
            ? `本轮未采信：${(cell.note === '' ? '证据不足以判定' : cell.note).split('。')[0]}。该格不计入分数。`
            : (cell.state === 'not-applicable'
              ? `不适用${cell.note === '' ? '' : `：${cell.note}`}`
              : '未评 —— 这份文件还没有被通读过'))
        const evidence = (cell.evidence ?? [])
          .filter(item => item !== null && typeof item === 'object' && typeof item.quote === 'string' && item.quote.trim() !== '')
        const attrLabel = cell.state !== 'rated' ? ''
          : (cell.attribution === 'submitter' ? '提交者'
            : (cell.attribution === 'other-party' ? '他人/审批方' : ''))
        return h('div', {
          key: cell.id,
          style: {
            marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(127,127,127,0.16)',
            fontSize: 12, lineHeight: 1.6,
          },
        }, [
          h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 700, whiteSpace: 'nowrap' } }, `${cell.id} ${cell.label}`),
            attrLabel === '' ? null : h('span', {
              style: Object.assign({}, S.tag, { marginRight: 0, whiteSpace: 'nowrap' }),
            }, attrLabel),
            h('span', {
              style: Object.assign({}, S.tag, {
                marginLeft: 'auto', marginRight: 0, whiteSpace: 'nowrap',
                fontWeight: 700,
                color: cell.state === 'rated' && cell.score <= 5 ? 'rgba(255,110,110,0.95)' : 'inherit',
              }),
            }, cell.state === 'rated' ? `${cell.score} 分` : stateLabel(cell))),
          h('div', { key: 'judge', style: { marginTop: 3 } }, judged),
          // ★ 0.7.15：证据页必须有**证据**。原来这里只有判定理由和「A4 模糊与夸大」这类
          //   0.3.x 旧维度的线索 —— 真正的原文引文一个字都没印，等于让人看判词不看证据。
          evidence.length === 0
            ? null
            : h('div', { key: 'ev', style: { marginTop: 4 } },
              evidence.slice(0, 4).map((item, index) => h('div', {
                key: index,
                style: { fontSize: 11.5, opacity: 0.82, lineHeight: 1.5, marginTop: 2 },
              }, `「${item.quote}」${typeof item.line === 'number' ? `　—— 第 ${item.line} 行` : ''}`))),
        ])
      }

      const defQuestion = id => (status?.layers?.definitions ?? []).find(item => item.id === id)?.question ?? ''

      // ★ 一层一卡，顺序由 PANEL_LAYER_ORDER 决定：表达 → 策略 → 执行 → 意图。
      //   原来四层挤在一张表里，既分不清层次，窄屏还会把「判定」列压成竖排。
      const group = id => {
        const layer = layers.layers?.find(item => item.id === id)
        const rows = cells.filter(cell => cell.layer === id)
        if (rows.length === 0) return null
        return h('div', { key: id, style: S.card }, [
          h('div', { key: 'title', style: S.secTitle },
            `${LAYER_SHORT[id] ?? id} · 权重 ${Math.round((layer?.weight ?? 0) * 100)}% · `
            + (layer === undefined || layer.value === null || layer.value === undefined
              ? '未评' : `${layer.display ?? Math.round(layer.value)} / 100`)),
          h('div', { key: 'q', style: S.muted }, defQuestion(id)),
          layer?.hasCriticalGap === true
            ? h('div', { key: 'gap', style: { marginTop: 2, fontSize: 11.5, color: 'rgba(255,150,120,0.95)' } },
              `含关键缺口 ${layer.criticalGapCells.join('、')} —— 层分取本层最弱的一格，别只看层分。`)
            : null,
          rows.map(cellRow),
        ])
      }

      return h('div', null, [
        h('div', { key: 'note', style: Object.assign({}, S.muted, { marginTop: 4 }) },
          `按 ${panelOrder.map(id => LAYER_SHORT[id] ?? id).join(' → ')} 顺序，每层一卡。`
          + '线索只指路（来自 A/B 维度），不构成判定。'),
        panelOrder.map(group),
        h('div', { key: 'foot', style: Object.assign({}, S.muted, { marginTop: 10, lineHeight: 1.6 }) },
          '未评 ／ 待确认 ／ 不适用 三者都不进分母 —— 把"我没看"算进分母，'
          + '等于把它当成 0 分或满分，两种都是撒谎。'),
      ])
    }

    /** 把面板上填的分变成宿主认识的 cells，调 RPC 试算。 */
    async function recomputeLayers() {
      setError(null)
      setBusy('正在试算四层分…')
      try {
        const cells = Object.entries(cellDraft)
          .filter(([, choice]) => choice !== '' && choice !== undefined)
          .map(([id, choice]) => {
            if (choice === 'na') return { id, state: 'notApplicable' }
            if (choice === 'und') return { id, state: 'undetermined' }
            // 归属**不在这里填**：面板只给分数。归属不明时四条件闸会自动把扣分降级为建议，
            // 这是设计如此 —— 快速试算不该顺手替用户认定"这是提交者的锅"。
            return { id, state: 'rated', score: Number(choice) }
          })
        const result = await rpc('layers', { cells })
        if (result?.ok === false) {
          setError({ message: result.error?.message ?? '试算失败', hint: result.error?.details?.hint ?? result.error?.hint })
          return
        }
        setLayersView(result?.layers ?? result)
        setView('overview')
      } catch (cause) {
        setError({ message: String(cause?.message ?? cause) })
      } finally {
        setBusy('')
      }
    }

    function renderScoring() {
      const layers = effectiveLayers()
      const cells = layers?.cells ?? []
      const defs = status?.layers?.definitions ?? []
      const anchors = status?.layers?.anchors ?? {}

      if (cells.length === 0) {
        return h('div', { style: S.card },
          h('div', { style: S.secTitle }, '十二格评分'),
          h('div', { style: S.muted }, '这份报告没有带四层数据 —— 宿主版本可能低于 0.5.0。'))
      }

      const cellDefOf = cellId => {
        for (const def of defs) {
          const found = (def.cells ?? []).find(item => item.id === cellId)
          if (found !== undefined) return found
        }
        return undefined
      }

      const row = cell => {
        const value = cellDraft[cell.id] ?? (cell.state === 'rated' ? String(cell.score)
          : cell.state === 'undetermined' ? 'und'
            : cell.state === 'not-applicable' ? 'na' : '')
        return h('tr', { key: cell.id },
          h('td', { style: Object.assign({}, S.td, { whiteSpace: 'nowrap', fontWeight: 700 }) }, cell.id),
          h('td', { style: S.td }, cell.label),
          h('td', { style: Object.assign({}, S.td, { fontSize: 11, opacity: 0.7, lineHeight: 1.45 }) },
            cellDefOf(cell.id)?.question ?? ''),
          h('td', { style: S.td },
            h('select', {
              value,
              style: Object.assign({}, S.select, { minWidth: 170, padding: '3px 6px', fontSize: 11.5 }),
              onChange: event => {
                const next = event.target.value
                setCellDraft(current => {
                  const copy = Object.assign({}, current)
                  if (next === '') delete copy[cell.id]
                  else copy[cell.id] = next
                  return copy
                })
              },
            }, CELL_CHOICES.map(choice => h('option', { key: choice.value, value: choice.value }, choice.label)))),
        )
      }

      const group = id => {
        const rows = cells.filter(cell => cell.layer === id)
        if (rows.length === 0) return null
        const def = defs.find(item => item.id === id)
        return h('tbody', { key: id },
          h('tr', null, h('td', {
            colSpan: 4,
            style: Object.assign({}, S.td, { fontWeight: 700, fontSize: 12, paddingTop: 12 }),
          }, `${LAYER_SHORT[id] ?? id} · ${def?.question ?? ''} · 权重 ${Math.round((def?.weight ?? 0) * 100)}%`)),
          rows.map(row),
        )
      }

      return h('div', { style: S.card }, [
        h('div', { key: 'title', style: S.secTitle }, '修订 · 给十二格打分（0–4）'),
        h('div', { key: 'sub', style: S.muted },
          '引擎只产证据，不给分。这里填完点「试算四层分」，只在本机重算，不重新解析文件。'),
        h('table', { key: 'table', style: Object.assign({}, S.table, { tableLayout: 'fixed' }) },
          h('colgroup', null, ['52px', '150px', null, '200px'].map((width, index) =>
            h('col', { key: index, style: width === null ? undefined : { width } }))),
          h('thead', null, h('tr', null, ['格', '检查点', '判什么', '你的判定'].map((label, index) =>
            h('th', { key: index, style: S.th }, label)))),
          panelOrder.map(group),
        ),
        h('div', { key: 'legend', style: Object.assign({}, S.muted, { marginTop: 8, lineHeight: 1.7 }) },
          Object.keys(anchors).length === 0 ? '' : Object.keys(anchors).map(Number).sort((a, b) => b - a)
            .map(key => `${key} ${anchors[key].label}`).join(' ｜ ')),
        h('div', { key: 'gate', style: Object.assign({}, S.muted, { marginTop: 6, lineHeight: 1.6 }) },
          '⚠️ 面板只填分数，**不填归属与四条件**。低于 10 分的格要算成扣分，必须在对话里补齐'
          + '「当前阶段必须完成 / 属提交者职责 / 全文确未完成 / 影响当前决定」四条，'
          + '否则报告会把它列为「未过闸、已降为建议」——这是刻意的，不是 bug。'),
        h('div', { key: 'actions', style: S.row },
          h('button', {
            style: busy === '' ? S.btnPrimary : Object.assign({}, S.btnPrimary, S.btnDisabled),
            disabled: busy !== '',
            onClick: recomputeLayers,
          }, busy === '' ? '试算四层分' : busy),
          h('button', {
            style: S.btn,
            onClick: () => { setCellDraft({}); setLayersView(null) },
          }, '清空并用宿主结果')),
      ])
    }

    function renderHeadline() {
      const scores = report.scores
      const observable = report.observable
      const indexA = scores.indexA
      const value = indexA.withheld ? null : indexA.value

      // ★ 面板第一屏必须和 markdown 第一节说同一句话。
      //   0.2.8 之前这里是「大号 11.3 + 表达体检 · 干净」，而 markdown 第一节写的是
      //   「Slop 特征：显著」——同一份报告两个结论，用户只信更大更靠前的那个。
      //   现在两边都从 report.observable 渲染，且首屏放**唯一的综合分数**：Slop 得分。
      const rows = observable?.rows ?? []
      const slop = observable?.slopScore
      const showLayer = value => (value === null || value === undefined ? '不适用' : value)
      const layers = observable?.layers ?? []

      return h('div', { style: S.card },
        h('div', { style: S.headline },
          h('div', {
            style: Object.assign({}, S.bigNum, {
              color: slop === null || slop === undefined
                ? 'rgba(127,127,127,0.7)'
                : (slop <= 20 ? 'rgba(120,200,140,0.95)' : slop <= 40 ? 'rgba(190,200,120,0.95)'
                  : slop <= 60 ? 'rgba(255,180,80,0.95)' : 'rgba(255,110,110,0.95)'),
            }),
          }, slop === null || slop === undefined ? '—' : slop),
          h('div', null,
            h('div', { style: S.band }, `0.3.x 三指数 · ${observable?.band ?? '不出分'}（越高越差）`),
            h('div', { style: Object.assign({}, S.muted, { marginTop: 4 }) },
              `表达 ${showLayer(layers[0]?.value)} · 执行 ${showLayer(layers[1]?.value)} · 决策 ${showLayer(layers[2]?.value)}`),
            h('div', { style: Object.assign({}, S.muted, { fontSize: 11, marginTop: 2 }) },
              '权重 20 / 40 / 40，初案未校准；越高越差 —— **不是四层质量分**，四层见上一张卡'),
          ),
        ),
        h('div', { style: Object.assign({}, S.muted, { marginTop: 8, lineHeight: 1.6 }) },
          `**边界**：${observable?.verdict ?? '本次未评估'} —— ${observable?.reason ?? ''}`),
        rows.length > 0
          ? h('div', { style: { marginTop: 10, fontSize: 12 } },
            rows.map((row, index) => h('div', {
              key: index,
              style: { display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 4 },
            },
            h('span', null, row.label),
            h('span', { style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, `${row.count} · ${row.where}`))))
          : null,
        rows.length > 0
          ? h('div', { style: Object.assign({}, S.muted, { marginTop: 8, fontSize: 11.5 }) },
            '这些是计数，不是判定：它证明"这份交付里拿不出"，不能证明"作者没做"。')
          : null,
        h('div', { style: { marginTop: 10, fontSize: 12, lineHeight: 1.6 } },
          `表达层面：${value === null ? '本次未评估' : `${value} / 100（${indexA.verdict.band}）`}。`,
          observable?.expressionNote ?? ''),
        h('div', { style: { marginTop: 6, fontSize: 12, lineHeight: 1.6 } },
          `执行层面：${observable?.executionGap === null || observable?.executionGap === undefined
            ? '不适用' : `${observable.executionGap} / 100`}。`,
          observable?.executionNote ?? ''),
        h('div', { style: { marginTop: 6, fontSize: 12, lineHeight: 1.6 } },
          `决策层面：${observable?.decisionGap === null || observable?.decisionGap === undefined
            ? '不适用' : `${observable.decisionGap} / 100`}。`,
          observable?.decisionNote ?? ''),
        h('div', { style: { marginTop: 10, fontSize: 12 } },
          h('span', { style: S.tag }, `可信度 ${scores.confidence.level}`),
          h('span', { style: S.tag }, `解析覆盖 ${(scores.coverage.parse * 100).toFixed(0)}%`),
          h('span', { style: S.tag }, `A 覆盖 ${(scores.coverage.evaluation * 100).toFixed(0)}%`),
          h('span', { style: S.tag }, `文档类型 ${report.docType.label}`),
        ),
        scores.coverage.withheldTotal
          ? h('div', { style: Object.assign({}, S.err, { marginTop: 10 }) },
            h('div', null, '⚠️ 解析覆盖率不足，本次只出局部结论。'),
            h('div', { style: S.k }, indexA.withheldReason ?? ''))
          : null,
        h('div', { style: { marginTop: 8 } },
          scores.confidence.reasons.map((reason, index) => h('div', { key: index, style: S.muted }, `· ${reason}`))),
      )
    }

    // 第二节「建议优先核实的三个方向 / 关键缺口」——排序固定（执行 → 决策依据 → 要你决定什么），
    // 措辞是按类别写死的模板，不生成判断。面板与 markdown 同源，避免又出现两套说法。
    function renderAsks() {
      const asks = report.observable?.asks ?? []
      if (asks.length === 0) return null
      return h('div', { style: S.card },
        h('div', { style: S.secTitle }, report.observable?.asksLabel ?? '建议优先核实的三个方向'),
        asks.map((item, index) => h('div', { key: index, style: { marginTop: 12 } },
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, `${index + 1}. ${item.title}`),
          h('div', { style: { fontSize: 12, marginTop: 5, lineHeight: 1.7 } },
            h('div', null, `要问：${item.ask}`),
            item.where === '' ? null : h('div', { style: S.muted }, `位置：${item.where}`),
            h('div', { style: S.muted }, `现状：${item.current ?? '—'}`),
            h('div', { style: S.muted }, `为什么要紧：${item.why}`),
            h('div', { style: S.muted }, `补什么：${item.fix}`),
            h('div', { style: S.muted }, `怎样算补齐：${item.done}`)))))
    }

    function renderDimensions(onlyIds, title = '逐维判定') {
      // 只渲染指定的维度（按层分组时用）；不传就是全部。
      const list = Array.isArray(onlyIds) && onlyIds.length > 0
        ? report.dimensions.filter(dimension => onlyIds.includes(dimension.id))
        : report.dimensions
      if (list.length === 0) return null
      // 列宽写死 + nowrap。中文表头在窄列里会**逐字竖排**（「权/重」「严/重/度」），
      // 表头行于是被撑成三行高，跟「维度」「状态」对不齐 —— 看上去像几个格子各自长了腿。
      // 宽度给够，内容一行的列就永远一行。
      //
      // ★ 0.3.11：光给宽度不够，还必须给 `table-layout: fixed`。
      //   自动布局下，写了 width 的窄列会被浏览器**当成最小宽度再往上摊**——
      //   于是「维度/权重/状态/严重度」各自多出一截空白，而唯一没有定宽、
      //   需要换行的「说明」反而被挤成一条细缝（实测只剩 ~240px，
      //   四列表头之间却能塞下四个指头宽的空白）。
      //   改成 fixed 之后：定宽列就是那个宽度，剩下的**全部**归「说明」。
      const colFirst = { width: 112, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
      const colWeight = { width: 50, whiteSpace: 'nowrap' }
      const colState = { width: 104, whiteSpace: 'nowrap' }
      const colSeverity = { width: 58, whiteSpace: 'nowrap' }
      const colNote = { wordBreak: 'break-word' }
      return h('div', { style: S.card },
        h('div', { style: S.secTitle }, title),
        h('table', { style: Object.assign({}, S.table, { tableLayout: 'fixed' }) },
          h('thead', null, h('tr', null,
            h('th', { style: Object.assign({}, S.th, colFirst) }, '维度'),
            h('th', { style: Object.assign({}, S.th, colWeight) }, '权重'),
            h('th', { style: Object.assign({}, S.th, colState) }, '状态'),
            h('th', { style: Object.assign({}, S.th, colSeverity) }, '严重度'),
            h('th', { style: Object.assign({}, S.th, colNote) }, '说明'),
          )),
          h('tbody', null, list.map(dimension => {
            const open = openDim[dimension.id] === true
            const stateLabel = dimension.index === 'B' ? '线索 · 不计分'
              : (dimension.state === 'scored' ? '已评估'
                : (dimension.state === 'not-applicable' ? '不适用'
                  : (dimension.state === 'observed' ? '已观测 · 不计分' : '未能评估')))
            return h(React.Fragment, { key: dimension.id },
              h('tr', {
                style: { cursor: dimension.hits.length > 0 ? 'pointer' : 'default' },
                onClick: () => {
                  if (dimension.hits.length === 0) return
                  setOpenDim(prev => Object.assign({}, prev, { [dimension.id]: !open }))
                },
              },
                h('td', { style: Object.assign({}, S.td, colFirst), title: `${dimension.id} ${dimension.label}` }, `${dimension.id} ${dimension.label}`),
                h('td', { style: Object.assign({}, S.td, colWeight, { fontVariantNumeric: 'tabular-nums' }) }, `${dimension.weight}%`),
                h('td', { style: Object.assign({}, S.td, colState) }, stateLabel),
                // 印不印严重度只读 `counts`（宿主算一次），不在客户端重下一遍判断 ——
                // 否则就会重演"markdown 印 —、客户端印 3"那件事。
                h('td', {
                  style: Object.assign({}, S.td, colSeverity, {
                    color: dimension.counts ? severityColor(dimension.severity) : 'inherit',
                    fontVariantNumeric: 'tabular-nums',
                  }),
                }, dimension.counts ? `${dimension.severity}` : '—'),
                h('td', { style: Object.assign({}, S.td, colNote, { fontSize: 11.5, opacity: 0.8 }) },
                  dimension.state === 'scored'
                    ? (dimension.summary ?? '')
                      + (dimension.hits.length === 0 && dimension.note !== undefined ? ` ⚠️ ${dimension.note}` : '')
                    : (dimension.reason ?? '')),
              ),
              open ? h('tr', null, h('td', { colSpan: 5, style: S.td },
                dimension.hits.map((hit, index) => h('div', { key: index, style: S.hit },
                  h('div', { style: { fontWeight: 600, marginBottom: 2 } }, `[${hit.rule}] 第 ${hit.line} 行`),
                  h('code', { style: S.snippet }, hit.snippet),
                  h('div', null, h('span', { style: S.k }, '为什么：'), hit.why),
                  h('div', null, h('span', { style: S.k }, '怎么改：'), hit.fix),
                  hit.note === undefined ? null : h('div', { style: S.k }, `检查范围：${hit.note}`),
                )),
                dimension.note === undefined ? null : h('div', { style: S.muted }, `补充：${dimension.note}`),
              )) : null,
            )
          })),
        ),
        list.every(dimension => dimension.hits.length === 0)
          ? h('div', { style: Object.assign({}, S.muted, { marginTop: 8 }) },
            '本次零命中。注意：零命中不等于干净 —— 也可能是规则没覆盖这个体裁或语种。')
          : null,
      )
    }

    // 执行（C）/ 决策（D）在逐维表里没有对应行 —— 它们不按维度拆。
    // 首页把它们印成两个大数字，读者翻到这页却找不到账本，等于**只给分数不给依据**。
    // 所以这两层自己摊开：分母怎么来的、扣在哪几行、缺的是什么。
    // 数据只读宿主算好的 `observable.layerEvidence`，客户端不重新算一遍。
    function renderLayerEvidence(onlyKeys, title = '执行 / 决策 的扣分依据（0.3.x 口径）') {
      const all = report.observable?.layerEvidence ?? []
      const layers = Array.isArray(onlyKeys) && onlyKeys.length > 0
        ? all.filter(layer => onlyKeys.includes(layer.key))
        : all
      if (layers.length === 0) return null

      const itemRow = (item, index) => h('div', {
        key: index,
        style: { marginTop: 5, fontSize: 12, lineHeight: 1.65 },
      }, [
        h('span', { key: 'at', style: Object.assign({}, S.k, { whiteSpace: 'nowrap' }) },
          item.line === null || item.line === undefined ? '（全篇）' : `第 ${item.line} 行`),
        ' ',
        h('span', { key: 'missing', style: S.tag }, item.missing),
        ' ',
        h('span', { key: 'text', style: { wordBreak: 'break-word' } }, item.text),
      ])

      const layerBlock = layer => {
        const head = `${layer.label}（${layer.key}） · 权重 ${layer.weight}% · `
          + (layer.value === null || layer.value === undefined ? '不出分' : `${layer.value} / 100`)
        const body = layer.items.length === 0
          ? h('div', { style: { fontSize: 12, marginTop: 6 } }, '本层没有扣分项。')
          : h('div', { style: { marginTop: 6 } }, layer.items.map(itemRow))
        return h('div', { key: layer.key, style: { marginTop: 14 } }, [
          h('div', { key: 'head', style: { fontWeight: 700, fontSize: 12.5 } }, head),
          h('div', { key: 'basis', style: Object.assign({}, S.muted, { marginTop: 4, lineHeight: 1.6 }) }, layer.basis),
          body,
        ])
      }

      return h('div', { style: S.card }, [
        h('div', { key: 'title', style: S.secTitle }, title),
        h('div', { key: 'sub', style: S.muted }, '动作项与主张项的逐条缺口，按行号列出；数据来自宿主算好的 observable.layerEvidence。'),
        ...layers.map(layerBlock),
      ])
    }

    function renderExcluded() {
      const excluded = report.scores.excluded
      if (excluded.length === 0) return null
      return h('div', { style: S.card },
        h('div', { style: S.secTitle }, '已退出计分的维度'),
        excluded.map(item => h('div', { key: item.id, style: { marginTop: 6, fontSize: 12 } },
          h('span', { style: S.tag }, item.state === 'not-applicable'
            ? '不适用'
            : (item.state === 'insufficient' ? '未能评估' : '已观测 · 不计分')),
          `${item.id} ${item.label} —— ${item.reason ?? ''}`)),
        h('div', { style: Object.assign({}, S.muted, { marginTop: 8 }) },
          '四态不互相顶替：不适用（这份文件不需要这一项）≠ 未能评估（我没法判）'
          + '≠ 已观测（数出来了，但不下判）≠ 0 分（判过了，没问题）。'),
      )
    }

    function renderDistill() {
      const distillation = report.distillation
      const elements = distillation.elements
      const block = (title, node) => h('div', { key: title, style: { marginTop: 12 } },
        h('div', { style: { fontWeight: 700, fontSize: 12.5, marginBottom: 4 } }, title),
        node)

      const quotes = list => (list ?? []).map((item, index) =>
        h('div', { key: index, style: S.quote }, h('span', { style: S.k }, `第 ${item.line} 行 `), item.text))

      return h('div', { style: S.card },
        h('div', { style: S.secTitle }, `五要素提炼 · ${distillation.levelLabel}`),
        h('div', { style: S.muted }, distillation.method),
        block('① 目的',
          elements.purpose.quotes.length === 0
            ? h('div', { style: { fontSize: 12 } }, `未明示 —— ${elements.purpose.conclusion}`)
            : h('div', null,
              h('div', { style: { fontSize: 12, marginBottom: 2 } }, `${elements.purpose.status} —— ${elements.purpose.conclusion}`),
              quotes(elements.purpose.quotes))),
        block('② 阐述',
          elements.exposition.items.length === 0
            ? h('div', { style: { fontSize: 12 } }, '原文没有可摘出的事实或背景句 —— 这是缺口。')
            : elements.exposition.items.map((item, index) => h('div', { key: index, style: S.quote },
              h('span', { style: S.tag }, item.kind),
              h('span', { style: S.k }, `第 ${item.line} 行 `), item.text))),
        block('③ 观点',
          elements.claims.items.length === 0
            ? h('div', { style: { fontSize: 12 } }, '原文没有可识别的主张句。')
            : elements.claims.items.map((item, index) => h('div', { key: index, style: S.quote },
              h('span', { style: S.tag }, item.support),
              h('span', { style: S.k }, `第 ${item.line} 行 `), item.text))),
        block('④ 态度',
          h('div', null,
            h('div', { style: { fontSize: 12 } }, `${elements.stance.value} —— ${elements.stance.conclusion}`),
            quotes(elements.stance.quotes))),
        block('⑤ 执行',
          elements.actions.items.length === 0
            ? h('div', { style: { fontSize: 12 } }, '原文没有动作类要求 —— 若这是方案或计划，本身就缺执行段。')
            : elements.actions.items.map((item, index) => h('div', { key: index, style: S.quote },
              h('span', { style: S.tag }, item.status),
              item.action,
              h('div', { style: S.k }, `责任人：${item.owner} ｜ 期限：${item.due} ｜ 第 ${item.line} 行`)))),
        block('证据与限制',
          distillation.evidenceAndLimits.length === 0
            ? h('div', { style: { fontSize: 12 } }, '原文没有标注依据、假设或限制 —— 结论强度无法判断。')
            : distillation.evidenceAndLimits.map((item, index) => h('div', { key: index, style: S.quote },
              h('span', { style: S.tag }, item.kinds.join(' / ')),
              h('span', { style: S.k }, `第 ${item.line} 行 `), item.text))),
        block('必须追问',
          (() => {
            // ★ 0.7.15：「本卡片只够快速了解…」是提醒，不是追问项，混在编号列表里读着别扭。
            const asks = distillation.questions.filter(question => !/^本卡片/u.test(question))
            const cautions = distillation.questions.filter(question => /^本卡片/u.test(question))
            return h('div', null,
              asks.length === 0
                ? h('div', { style: { fontSize: 12 } }, '无（各要素均已写明）。')
                : h('ol', { style: S.list },
                  asks.map((question, index) => h('li', { key: index }, question))),
              cautions.length === 0
                ? null
                : h('div', { style: Object.assign({}, S.muted, { marginTop: 4, fontSize: 11.5 }) }, cautions.join(' ')))
          })()),
        block('保真与压缩',
          h('div', null,
            h('div', { style: { fontSize: 12 } }, distillation.fidelity.note),
            h('div', { style: Object.assign({}, S.muted, { marginTop: 4 }) },
              `原 ${distillation.compression.sentencesTotal} 句，保留 ${distillation.compression.sentencesKept} 句`
              + `（${(distillation.compression.ratio * 100).toFixed(0)}%），删去 ${distillation.compression.droppedCount} 句套话或旁支。`),
            // ★ 0.7.15：原来这里把**每一句没被选中的原文**都摊出来（实测 38 行），
            //   还带「未被选入（信息量排序靠后，且不含硬保护项）」—— 那是调试信息不是给读者看的，
            //   看的人只会以为工具坏了。要逐句核对，去 MD 报告。
            h('div', { style: Object.assign({}, S.muted, { marginTop: 6, fontSize: 11.5 }) },
              '删掉的只是套话与旁支：事实、判断、条件与责任都保留下来了。'))),
      )
    }

    function renderReport() {
      const tabs = [
        { id: 'overview', label: '总览' },
        { id: 'evidence', label: '证据' },
        { id: 'distill', label: '提炼' },
        { id: 'markdown', label: 'MD报告' },
      ]
      return h('div', null,
        h('div', { style: Object.assign({}, S.tabs, { marginTop: 14 }) },
          tabs.map(item => h('button', {
            key: item.id,
            style: view === item.id ? S.tabActive : S.tab,
            onClick: () => setView(item.id),
          }, item.label)),
          h('div', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: copyMarkdown }, '复制MD'),
          h('button', { style: S.btn, onClick: saveReport }, '保存'),
        ),
        copied === '' ? null : h('div', { style: Object.assign({}, S.muted, { marginTop: 6 }) }, copied),
        // ★ 0.6.0：面板只留一套口径 —— 四层十二格。
        //   0.3.x 的三指数、逐维表、执行/决策明细**不再渲染**：
        //   两套分数并排出现时，读者只会问"到底看哪个"，而它们方向还相反。
        //   那些数字仍在报告里作内部依据（四层分就是从它们推出来的），只是不再上屏。
        view === 'overview'
          ? h('div', null, renderLayersCard())
          : null,
        view === 'evidence' ? renderCellEvidence() : null,
        view === 'distill' ? renderDistill() : null,
        view === 'markdown'
          ? h('div', { style: S.card }, h('pre', { style: S.pre }, report.markdown ?? ''))
          : null,
        h('div', { style: Object.assign({}, S.muted, { marginTop: 12 }) },
          `解析：${report.file.format} · ${report.file.chars} 字符`
          + `${report.file.truncated ? '（已截断）' : ''} · 覆盖率 ${(report.parse.coverage * 100).toFixed(0)}%`
          + ` · 段落/句 ${report.stats.paragraphs}/${report.stats.sentences} · 用时 ${report.elapsedMs} ms`),
        report.parse.warnings.length === 0
          ? null
          : h('div', { style: { marginTop: 6 } },
            report.parse.warnings.map((warning, index) => h('div', { key: index, style: S.muted }, `· ${warning}`))),
        h('div', { style: Object.assign({}, S.muted, { marginTop: 8 }) },
          '本报告由本地规则引擎自动生成，不构成对作者的评价；判的是文件能不能用，不鉴定作者、不用于员工评价。'),
      )
    }

    function renderRecent() {
      if (recent.length === 0) return null
      const score = value => (value === null || value === undefined ? '不出分' : String(value))
      return h('div', { style: S.card },
        h('div', { style: S.secTitle }, '最近报告（仅内存，不落盘）· 点击可重新打开'),
        recent.slice(0, 8).map((item, index) => h('div', {
          key: index,
          onClick: () => openRecent(index),
          title: '点击重新打开这份报告',
          style: {
            fontSize: 11.5,
            marginTop: 4,
            opacity: 0.85,
            cursor: 'pointer',
            textDecoration: 'underline dotted',
            textUnderlineOffset: 3,
          },
        }, `${item.filename} · ${item.docType} · 体检 ${score(item.slop)} · 表达 ${score(item.indexA)} · 可信度 ${item.confidence}`)),
      )
    }

    return h('div', { style: S.wrap },
      h('div', { style: S.head },
        h('span', { style: S.title }, PANEL_LABEL),
        h('span', { style: S.titleEn }, PANEL_LABEL_EN),
        // 版本号紧跟英文名：读者一眼知道自己在用的哪一版，不用去翻设置。
        h('span', {
          style: { fontSize: 11, opacity: 0.55, fontFamily: 'ui-monospace, monospace' },
        }, status === null ? '' : `v${status.engineVersion}`),
        h('a', {
          href: REPO_URL,
          target: '_blank',
          rel: 'noreferrer',
          title: `在 GitHub 上查看仓库：${REPO_URL}`,
          style: {
            marginLeft: 'auto', fontSize: 11.5, color: 'rgba(120,160,255,0.95)',
            textDecoration: 'underline dotted', textUnderlineOffset: 3, cursor: 'pointer',
          },
        }, 'GitHub ↗'),
      ),
      renderStatusLine(),
      h('div', { style: S.tabs },
        h('button', { style: tab === 'upload' ? S.tabActive : S.tab, onClick: () => setTab('upload') }, '上传文件'),
        h('button', { style: tab === 'paste' ? S.tabActive : S.tab, onClick: () => setTab('paste') }, '粘贴文本'),
      ),
      renderInput(),
      renderControls(),
      error === null ? null : h('div', { style: S.err },
        h('div', null, error.message),
        error.hint === undefined ? null : h('div', { style: S.k }, error.hint)),
      report === null ? null : renderReport(),
      report === null ? renderRecent() : null,
    )
  }

  // ── 模块契约：{ name, inject, apply } ──────────────────────────────
  const name = 'kill-ai-slop-settings'

  /**
   * `connection` 是面板必需的（面板要调 RPC）。这一层只跑在 web 面板，
   * 所以在这里写死 'connection' 是安全的；宿主侧则必须用 ctx.inject(['connection'], …)
   * 做可选依赖，否则 headless / tui profile 会让整个插件停在 inactive。
   */
  const inject = ['slots', 'connection']

  function apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: PANEL_ID,
      order: 23,
      label: () => PANEL_LABEL,
      inject: () => ({
        // 拆包：成功是 { ok:true, value:<载荷> }，失败是 { ok:false, error:{…} }
        rpc: (method, payload, signal) =>
          ctx.connection.rpc.call('/api', RPC_ENDPOINT, { method, payload: payload || {} }, signal)
            .then(result => (result && result.ok === true ? result.value : result)),
      }),
    }, Panel))
  }

  return { name, inject, apply }
}
    return createClientPlugin(require('react'))
  },
})
