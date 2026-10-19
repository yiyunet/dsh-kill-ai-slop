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

export function createClientPlugin(React) {
  const h = React.createElement
  const { useCallback, useEffect, useMemo, useRef, useState } = React

  /** RPC 端点名 —— 必须与宿主 plugin-src/host/rpc.mjs 的 RPC_ENDPOINT 完全一致。 */
  const RPC_ENDPOINT = 'dsh-kill-ai-slop'

  /** 面板挂载 id / 显示名。order 23 —— 须大于既有面板的排序号，否则会排到前面。 */
  const PANEL_ID = 'dsh-kill-ai-slop'
  const PANEL_LABEL = 'AI垃圾过滤'
  const PANEL_LABEL_EN = 'Kill AI Slop'

  const S = {
    wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.65, color: 'inherit' },
    head: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 },
    title: { fontSize: 16, fontWeight: 700 },
    titleEn: { fontSize: 12, opacity: 0.55, letterSpacing: '0.02em' },
    version: { marginLeft: 'auto', fontSize: 11, opacity: 0.5, fontFamily: 'ui-monospace, monospace' },
    note: { fontSize: 11.5, opacity: 0.62, marginBottom: 10, lineHeight: 1.6 },
    tabs: { display: 'flex', gap: 6, marginBottom: 10 },
    tab: {
      padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
      border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
    },
    tabActive: {
      padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
      border: '1px solid rgba(120,160,255,0.9)', background: 'rgba(120,160,255,0.16)', color: 'inherit', fontWeight: 600,
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
    th: { textAlign: 'left', padding: '5px 6px', borderBottom: '1px solid rgba(127,127,127,0.3)', fontWeight: 600, fontSize: 11.5, opacity: 0.75 },
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
          setView('overview')
          setOpenDim({})
        })
        .catch(cause => setError({ message: String(cause?.message ?? cause) }))
    }, [rpc])

    const limits = status?.limits ?? {}
    const maxBytes = Number(limits.maxRpcBytes ?? limits.maxFileBytes ?? 12 * 1024 * 1024)

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

    async function runAudit() {
      setError(null)
      setCopied('')
      try {
        if (tab === 'upload') {
          if (file === null) {
            setError({ message: '请先选择或拖入一个文件。', hint: '支持 docx / pptx / xlsx / pdf / txt / md / csv / json / html。' })
            return
          }
          setBusy('正在解析并体检…')
          const base64 = await fileToBase64(file)
          const result = await rpc('audit', { filename: file.name, base64, docType, level })
          if (result?.ok === false) {
            setError({ message: result.error?.message ?? '体检失败', hint: result.error?.details?.hint })
            setReport(null)
            return
          }
          setReport(result.report)
          setView('overview')
          refreshRecent()
        } else {
          if (pasted.trim() === '') {
            setError({ message: '请先粘贴要分析的文本。', hint: '粘贴原文，不要粘贴已经总结过的版本。' })
            return
          }
          setBusy('正在体检…')
          const result = await rpc('auditText', { text: pasted, filename: '粘贴文本.txt', docType, level })
          if (result?.ok === false) {
            setError({ message: result.error?.message ?? '体检失败', hint: result.error?.details?.hint })
            setReport(null)
            return
          }
          setReport(result.report)
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
              ? `支持 docx / pptx / xlsx / pdf / txt / md / csv / json / html；面板上限 ${fmtBytes(maxBytes)}`
              : `${fmtBytes(file.size)} · 点此可重新选择`),
        ),
        h('input', {
          type: 'file',
          ref: inputRef,
          style: { display: 'none' },
          accept: '.txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.html,.htm,.rtf,.docx,.pptx,.xlsx,.pdf',
          onChange: event => pickFile(event.target.files?.[0]),
        }),
      )
    }

    function renderControls() {
      const docTypes = status?.docTypes ?? [{ id: 'auto', label: '自动判断' }]
      const levels = status?.levels ?? [{ id: 'summary', label: '工作摘要' }]
      return h('div', { style: S.row },
        h('div', { style: S.field },
          h('span', { style: S.label }, '文档类型'),
          h('select', { style: S.select, value: docType, onChange: event => setDocType(event.target.value) },
            docTypes.map(item => h('option', { key: item.id, value: item.id }, item.label)))),
        h('div', { style: S.field },
          h('span', { style: S.label }, '提炼档位'),
          h('select', { style: S.select, value: level, onChange: event => setLevel(event.target.value) },
            levels.map(item => h('option', { key: item.id, value: item.id }, item.label)))),
        h('div', { style: { flex: 1 } }),
        h('button', {
          style: busy === '' ? S.btnPrimary : Object.assign({}, S.btnPrimary, S.btnDisabled),
          disabled: busy !== '',
          onClick: runAudit,
        }, busy === '' ? '开始体检' : busy),
      )
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
            h('div', { style: S.band }, `体检得分 · ${observable?.band ?? '不出分'}`),
            h('div', { style: Object.assign({}, S.muted, { marginTop: 4 }) },
              `表达 ${showLayer(layers[0]?.value)} · 执行 ${showLayer(layers[1]?.value)} · 决策 ${showLayer(layers[2]?.value)}`),
            h('div', { style: Object.assign({}, S.muted, { fontSize: 11, marginTop: 2 }) },
              '权重 20 / 40 / 40，初案未校准；越高越重'),
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

    function renderDimensions() {
      return h('div', { style: S.card },
        h('div', { style: S.secTitle }, '逐维判定'),
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, '维度'),
            h('th', { style: S.th }, '权重'),
            h('th', { style: S.th }, '状态'),
            h('th', { style: S.th }, '严重度'),
            h('th', { style: S.th }, '说明'),
          )),
          h('tbody', null, report.dimensions.map(dimension => {
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
                h('td', { style: S.td }, `${dimension.id} ${dimension.label}`),
                h('td', { style: Object.assign({}, S.td, { fontVariantNumeric: 'tabular-nums' }) }, `${dimension.weight}%`),
                h('td', { style: S.td }, stateLabel),
                h('td', { style: Object.assign({}, S.td, { color: dimension.state === 'scored' ? severityColor(dimension.severity) : 'inherit' }) },
                  dimension.state === 'scored' ? `${dimension.severity}` : '—'),
                h('td', { style: Object.assign({}, S.td, { fontSize: 11.5, opacity: 0.8 }) },
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
        report.dimensions.every(dimension => dimension.hits.length === 0)
          ? h('div', { style: Object.assign({}, S.muted, { marginTop: 8 }) },
            '本次零命中。注意：零命中不等于干净 —— 也可能是规则没覆盖这个体裁或语种。')
          : null,
      )
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
          distillation.questions.length === 0
            ? h('div', { style: { fontSize: 12 } }, '无（各要素均已写明）。')
            : h('ol', { style: S.list },
              distillation.questions.map((question, index) => h('li', { key: index }, question)))),
        block('保真与压缩',
          h('div', null,
            h('div', { style: { fontSize: 12 } }, distillation.fidelity.note),
            h('div', { style: Object.assign({}, S.muted, { marginTop: 4 }) },
              `${distillation.compression.sentencesTotal} 句 → ${distillation.compression.sentencesKept} 句`
              + `（保留 ${(distillation.compression.ratio * 100).toFixed(0)}%），删去 ${distillation.compression.droppedCount} 句。`),
            distillation.compression.dropped.length === 0
              ? null
              : h('div', { style: { marginTop: 6 } },
                distillation.compression.dropped.map((item, index) => h('div', { key: index, style: S.muted },
                  `· 第 ${item.line} 行：${item.text} —— ${item.why}`))))),
      )
    }

    function renderReport() {
      const tabs = [
        { id: 'overview', label: '总览' },
        { id: 'evidence', label: '证据' },
        { id: 'distill', label: '提炼' },
        { id: 'markdown', label: 'Markdown' },
      ]
      return h('div', null,
        h('div', { style: Object.assign({}, S.tabs, { marginTop: 14 }) },
          tabs.map(item => h('button', {
            key: item.id,
            style: view === item.id ? S.tabActive : S.tab,
            onClick: () => setView(item.id),
          }, item.label)),
          h('div', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: copyMarkdown }, '复制 Markdown'),
          h('button', { style: S.btn, onClick: saveReport }, '保存报告'),
        ),
        copied === '' ? null : h('div', { style: Object.assign({}, S.muted, { marginTop: 6 }) }, copied),
        // 「表达指数」那张卡已整块删掉：11.3 在首屏出现两次（Slop 拆解里的「表达 11.3」、
        // 三层的「表达层面：11.3 / 100」），再来一张卡就是第三次。首屏已经讲完的事，不必再占一屏。
        view === 'overview' ? h('div', null, renderHeadline(), renderAsks(), renderExcluded()) : null,
        view === 'evidence' ? renderDimensions() : null,
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
        h('span', { style: S.version }, status === null ? '' : `v${status.engineVersion}`),
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
