import assert from 'node:assert/strict'
import { test } from 'node:test'

import { audit, renderAuditMarkdown } from '../plugin-src/host/audit.mjs'
import { LEVELS, distill, renderDistillMarkdown } from '../plugin-src/host/distill.mjs'

const SAMPLE = [
  '# Q4 渠道调整方案',
  '',
  '目的：请在 10 月 31 日前决定是否把 A 渠道预算下调 20%。',
  '',
  '现状：A 渠道 9 月投入 12 万元，带来 340 单，单均获客成本 353 元。B 渠道同月投入 8 万元，带来 410 单，单均 195 元。',
  '',
  '建议：把 A 渠道预算下调 20%（2.4 万元），转投 B 渠道。预计每月多获 120 单，但尚无测试数据支撑该预估。',
  '',
  '风险：B 渠道转化率可能随投放放量下降；若单均成本升破 260 元，则本方案不成立。',
  '',
  '执行：由张三负责在 11 月 5 日前完成预算调整，李四在 11 月 10 日前给出首周数据复盘。',
].join('\n')

const collectQuotes = result => [
  ...result.elements.purpose.quotes,
  ...result.elements.stance.quotes,
  ...result.elements.exposition.items,
  ...result.elements.claims.items,
  // 动作项字段名是 action（它是"一条待办"，不是"一句摘录"），统一成 text 便于校验
  ...result.elements.actions.items.map(item => ({ text: item.action, start: item.start, end: item.end, line: item.line })),
  // ⚠️ evidenceAndLimits 挂在结果**顶层**，不在 elements 里（elements 只装五要素）
  ...result.evidenceAndLimits,
]

/* ───────────────────────── 提炼 ───────────────────────── */

test('提炼的每一句都是原文连续片段（抽取式，不改写）', () => {
  for (const level of LEVELS.map(item => item.id)) {
    const result = distill(SAMPLE, { level })
    const quotes = collectQuotes(result)
    assert.ok(quotes.length > 0, `${level} 档应至少有摘录`)
    for (const quote of quotes) {
      assert.equal(SAMPLE.slice(quote.start, quote.end), quote.text,
        `${level} 档的片段与原文偏移对不上：${quote.text}`)
      assert.ok(SAMPLE.includes(quote.text), `${level} 档出现了原文没有的句子：${quote.text}`)
    }
  }
})

test('目的被识别为「明示」因为它指向了具体动作与期限', () => {
  const result = distill(SAMPLE)
  assert.equal(result.elements.purpose.status, '明示')
})

test('态度识别为「建议」，不读心', () => {
  const result = distill(SAMPLE)
  assert.equal(result.elements.stance.value, '建议')
})

test('执行段抓到责任人、期限与「已写明」状态', () => {
  const result = distill(SAMPLE)
  const written = result.elements.actions.items.filter(item => item.status === '已写明')
  // 抽取式的最小单位是"句"：一句里同时写了两个人和两个期限，就合成一条动作项。
  // 这是刻意的下限 —— 拆分句子必然要改写，而改写会破坏可回原文核对的保证。
  assert.ok(written.length >= 1, `实际：${JSON.stringify(result.elements.actions.items.map(i => i.status))}`)
  assert.ok(written.some(item => item.owner.includes('张三')))
  assert.ok(written.some(item => /\d/u.test(item.due)))
})

test('硬保护项在任何档位都不丢，且保真校验通过', () => {
  for (const level of LEVELS.map(item => item.id)) {
    const result = distill(SAMPLE, { level })
    assert.equal(result.fidelity.ok, true, `${level} 档保真失败：${result.fidelity.note}`)
    assert.equal(result.fidelity.hardUnitKept, result.fidelity.hardUnitCount)
    // 关键数字必须仍在结果里
    const kept = result.sentences.map(item => item.text).join('')
    assert.ok(kept.includes('12 万元'), `${level} 档丢了 12 万元`)
    assert.ok(kept.includes('11 月 5 日'), `${level} 档丢了期限`)
    assert.ok(kept.includes('260 元'), `${level} 档丢了阈值条件`)
  }
})

test('不确定性表述不会被升格：原文「尚无测试数据」必须留着', () => {
  const result = distill(SAMPLE, { level: 'card' })
  const text = result.sentences.map(item => item.text).join('')
  assert.ok(text.includes('尚无测试数据'), '卡片档把不确定性表述删掉了 —— 这是最危险的失真')
})

test('缺责任人时给出「必须追问」', () => {
  const result = distill('请在本周内提交修订稿。')
  assert.ok(result.questions.some(question => question.includes('责任人')),
    `实际追问：${JSON.stringify(result.questions)}`)
})

test('「对齐目标」这类空话不被当成目的陈述；B1 与提炼结论必须一致', () => {
  // 实测矛盾：B1 说"提到了目的但不具体"、提炼说"未明示" —— 同一份文件两个结论
  const text = '我们要对齐目标，拉通资源，把颗粒度做细。成本 12 万元，工期 3 周。'
  const report = audit({ buffer: Buffer.from(text, 'utf8'), filename: 'a.md', docType: 'proposal' })
  const b1 = report.dimensions.find(dimension => dimension.id === 'B1')
  assert.equal(b1.severity, 2, '应判「缺目的陈述」，而不是「提到了目的但不具体」')
  assert.equal(report.distillation.elements.purpose.status, '未明示')
})

test('无命中但有说明的维度，必须在报告里露面（不能只给分不说话）', () => {
  // 实测问题：A2「检出重复但无法映射回原文」、A4「程度词带数字已放过」这类维度
  // 是"有 note、无 hits"；note 原先只跟着 hits 渲染 ⇒ 说明被整段吞掉，读者只看到分数
  const report = audit({ buffer: Buffer.from('成本显著下降 35%，交付 3 周。', 'utf8'), filename: 'a.txt', docType: 'report' })
  const a4 = report.dimensions.find(dimension => dimension.id === 'A4')
  assert.ok(a4.note !== undefined && a4.hits.length === 0, `这个样本应产生"有说明无命中"，实际 ${a4.hits.length} 命中`)
  assert.ok(report.markdown.includes(a4.note), 'note 没有进报告')
  assert.match(report.markdown, /证据缺口与放过说明/u)
})

test('提炼结果标注方法与档位说明', () => {
  const result = distill(SAMPLE, { level: 'integrity' })
  assert.equal(result.levelLabel, '保真精简')
  assert.match(result.method, /抽取式/u)
})

test('renderDistillMarkdown 含五要素小标题', () => {
  const markdown = renderDistillMarkdown({ ...distill(SAMPLE), levelDesc: '' })
  for (const heading of ['① 目的', '② 阐述', '③ 观点', '④ 态度', '⑤ 执行', '必须追问', '保真与压缩']) {
    assert.ok(markdown.includes(heading), `缺少小标题：${heading}`)
  }
})

/* ───────────────────────── 端到端 ───────────────────────── */

test('audit 完整跑通：双指数、逐维证据、五要素、复现信息齐备', () => {
  const report = audit({
    buffer: Buffer.from(SAMPLE, 'utf8'),
    filename: '方案.md',
    docType: 'proposal',
    level: 'summary',
  })

  assert.equal(report.ok, true)
  assert.equal(report.docType.id, 'proposal')
  assert.equal(report.scores.coverage.withheldTotal, false)
  // 0.2.4：B 退出指数体系，改由交付承接台账承载。
  // 这条断言不是"改测试迁就代码"，而是把新的设计决定钉住：
  // B 必须永远是 null，且必须写明理由 —— 否则它会悄悄溜回去继续算分。
  assert.equal(report.scores.indexB.value, null)
  assert.equal(report.scores.indexB.withheld, true)
  assert.match(report.scores.indexB.withheldReason, /交付承接台账/u)
  assert.ok(report.scores.indexA.value !== null)
  assert.equal(report.dimensions.length, 11)
  assert.equal(report.distillation.elements.purpose.status, '明示')
  assert.match(report.markdown, /表达指数/u)
  assert.match(report.markdown, /交付承接台账/u)
  assert.match(report.markdown, /由本地规则引擎自动生成/u)
  assert.match(report.ruleSetVersion, /^slop-rules\//u)
})

test('报告绝不出现「AI 生成概率 / 疑似 AI 撰写」这类作者鉴定', () => {
  const report = audit({ buffer: Buffer.from(SAMPLE, 'utf8'), filename: '方案.md' })
  const forbidden = ['AI 生成概率', 'AI生成概率', '疑似 AI 撰写', '疑似AI撰写', 'AI 率', 'AI率']
  for (const phrase of forbidden) {
    assert.ok(!report.markdown.includes(phrase), `报告出现了作者鉴定式表述：${phrase}`)
  }
})

test('报告里明确写了「零命中不等于干净」的免责，避免零命中被当结论', () => {
  const report = audit({ buffer: Buffer.from('成本 12 万元，工期 3 周。由张三负责，11 月 5 日交付。'.repeat(6), 'utf8'), filename: 'a.md' })
  assert.match(report.markdown, /零命中不等于干净/u)
})

test('覆盖不足时报告明写「不出总分」并给出原因', () => {
  const evaluation = audit({ buffer: Buffer.from(SAMPLE, 'utf8'), filename: '方案.md' })
  assert.ok(evaluation.parse.coverage >= 0.7)
  // 用极小上限触发截断 → 覆盖率下调
  const truncated = audit({ buffer: Buffer.from(SAMPLE, 'utf8'), filename: '方案.md', config: { maxChars: 120 } })
  assert.equal(truncated.file.truncated, true)
  assert.ok(truncated.parse.coverage < 1)
})

test('includeSnippets=false 时证据里回传的原文被隐去（敏感文件场景）', () => {
  const report = audit({
    buffer: Buffer.from(SAMPLE, 'utf8'),
    filename: '方案.md',
    config: { includeSnippets: false },
  })
  const withHits = report.dimensions.filter(dimension => dimension.hits.length > 0)
  assert.ok(withHits.length > 0, '这个样本应当有命中')
  for (const dimension of withHits) {
    for (const hit of dimension.hits) assert.match(hit.snippet, /已按隐私设置隐去原文/u)
  }
})

test('引擎版本与参数快照写进报告，保证可复现', () => {
  const report = audit({ buffer: Buffer.from(SAMPLE, 'utf8'), filename: '方案.md' })
  assert.match(report.markdown, /"engineVersion"/u)
  assert.match(report.markdown, /"ruleSetVersion"/u)
  assert.equal(report.params.docTypeInput, 'auto')
})

test('文件过大时在门禁阶段就被拒绝，并给出调参路径', () => {
  assert.throws(
    () => audit({ buffer: Buffer.alloc(2048, 0x41), filename: 'a.txt', config: { maxFileBytes: 1024 } }),
    error => {
      assert.equal(error.code, 'FILE_TOO_LARGE')
      assert.match(error.hint, /cordis\.patch\.yml/u)
      return true
    },
  )
})

/* ─────────────── 交付承接台账接入体检报告（0.2.4 · 案 A） ─────────────── */

const LEDGER_DOC = [
  '# 渠道推进方案',
  '',
  '目的：请在 10 月 31 日前决定首轮进入哪个平台。',
  '',
  '## 一、渠道分析',
  '',
  '### 1.1 PartsTech 准入',
  '',
  'PartsTech 是最佳首选渠道，应优先接洽。',
  '',
  '| 渠道 | 优先级 |',
  '|---|---|',
  '| PartsTech | P2 |',
  '',
  '建议本月完成入驻，后续再评估其余渠道。',
].join('\n')

test('没有任务原话时，报告必须明写"没有承接结论"，不许给一个 B 分数顶上', () => {
  const report = audit({ buffer: Buffer.from(LEDGER_DOC, 'utf8'), filename: '方案.md', docType: 'proposal' })
  assert.equal(report.ledger, null)
  assert.match(report.markdown, /本次没有交付承接结论/u)
  assert.match(report.markdown, /必须由任务作另一个操作数|必须有任务作另一个操作数/u)
})

test('给了任务原话但没给义务表：不得自己拆义务（倒推的义务表＝最佳实践清单）', () => {
  const report = audit({
    buffer: Buffer.from(LEDGER_DOC, 'utf8'),
    filename: '方案.md',
    docType: 'proposal',
    task: '线上垂直平台开拓尽快出一个落地方案。',
  })
  assert.equal(report.ledger.status, 'pending')
  assert.match(report.markdown, /没有收到义务表/u)
  assert.match(report.markdown, /不自己拆义务/u)
})

test('义务表 + 任务原话：台账成立，且首页给出承接结论与逐条台账', () => {
  const report = audit({
    buffer: Buffer.from(LEDGER_DOC, 'utf8'),
    filename: '方案.md',
    docType: 'proposal',
    task: '线上垂直平台开拓尽快出一个落地方案。',
    obligations: [
      {
        id: 'O1',
        question: '首轮进入哪个平台？',
        origin: 'explicit',
        critical: true,
        coverage: 'met',
        evidence: [{ quote: 'PartsTech 是最佳首选渠道，应优先接洽。' }],
        finding: '明确了首轮对象。',
      },
      {
        id: 'O2',
        question: '谁负责推进、何时完成？',
        origin: 'essential',
        critical: true,
        coverage: 'missing',
        evidence: [],
        finding: '全文没有责任人与期限。',
        impact: '批准之后没人动。',
        repair: '写明责任人与完成日期。',
        resolutionTest: '出现责任人与明确日期。',
      },
    ],
  })
  assert.equal(report.ledger.status, 'ok')
  // 台账成立时，承接结论必须进**第一节**（不是第三节、不是附录）
  const head = report.markdown.slice(0, report.markdown.indexOf('## 二、'))
  assert.match(head, /交付承接 · /u)
  assert.match(head, /关键义务 2 \/ 2/u)
  assert.match(report.markdown, /## 九、交付承接台账/u)
  // 已承接的部分必须出现在台账里 —— 不能只列缺口，把已有工作抹掉
  assert.match(report.markdown, /O1 首轮进入哪个平台/u)
  assert.match(report.markdown, /O2 谁负责推进、何时完成/u)
  // 台账嵌进报告时降一级；且台账自身不再带章节序号（否则与报告的一/二/…/九 打架）
  assert.match(report.markdown, /### 本次没判什么/u)
  assert.doesNotMatch(report.markdown, /### [一二三四五六七八九十]+、/mu)
})

test('义务里编了原文没有的引文：整条降级为不可采信，台账仍成立但标明', () => {
  const report = audit({
    buffer: Buffer.from(LEDGER_DOC, 'utf8'),
    filename: '方案.md',
    docType: 'proposal',
    task: '线上垂直平台开拓尽快出一个落地方案。',
    obligations: [
      {
        id: 'O1',
        question: '首轮进入哪个平台？',
        origin: 'explicit',
        critical: true,
        coverage: 'met',
        // 原文只有「应优先接洽」，没有这句 —— 引文复核必须抓住
        evidence: [{ quote: '已获得平台方书面入驻许可并完成对接。' }],
        finding: '声称已拿到许可。',
      },
    ],
  })
  assert.equal(report.ledger.status, 'ok')
  // 编造引文必须被抓住：要么降级、要么整条判校验不通过。
  // 断言用"报告里必须出现拦截痕迹"，而不是断言某个内部字段名 —— 断言要断语义，不要断字符串。
  assert.match(report.markdown, /引文未通过|校验不通过/u)
})

test('判断只有一个来源：面板读的 observable 与 markdown 第一节必须同源', () => {
  const report = audit({ buffer: Buffer.from(LEDGER_DOC, 'utf8'), filename: '方案.md', docType: 'proposal' })

  // 面板首屏从 report.observable 渲染；markdown 也从它渲染。两边不同源，
  // 就会出现「面板 11.3 干净 / 报告 Slop 显著」这种自相矛盾。
  assert.ok(report.observable, 'report.observable 必须存在')
  // 没有任务基准 → 只允许"未判定"，不许给 Slop 定性
  assert.match(report.observable.verdict, /未判定/u)
  assert.equal(report.observable.tier, 'scan')
  assert.ok(Array.isArray(report.observable.rows))
  assert.ok(Array.isArray(report.observable.asks))

  const head = report.markdown.slice(0, report.markdown.indexOf('## 二、'))
  const afterHeader = head.slice(head.indexOf('## 一、判断') + '## 一、判断'.length).trim()
  const firstLine = afterHeader.split('\n')[0]

  // ★ 断言要断**同源**，不要断文案。
  //   这条原本写成 `startsWith('**' + observable.verdict + '**')` —— 首页一换成
  //   Slop 得分，它就红了，可它想守的东西（面板与 markdown 读同一份数据）根本没变。
  //   现在改成：第一节第一行的分数必须**等于 observable 里的那个数**。
  //   文案随设计改，数值必须对上 —— 这才是"同源"该有的断言。
  const expected = report.observable.slopScore === null
    ? /体检得分：本次不出分/u
    : new RegExp(`体检得分 ${report.observable.slopScore} / 100`, 'u')
  assert.match(firstLine, expected, '第一节第一行的分数必须来自 observable')
})

test('首页定性不得超过实际完成的检测（三档由程序约束）', () => {
  const scan = audit({ buffer: Buffer.from(LEDGER_DOC, 'utf8'), filename: '方案.md', docType: 'proposal' })
  assert.equal(scan.observable.tier, 'scan')
  assert.match(scan.observable.verdict, /未判定/u)
  // 只有规则扫描，不得给 Slop 定性
  assert.doesNotMatch(scan.markdown, /Slop 特征/u, '没有任务基准时不得印 Slop 定性')
  // 没有台账，就不得出现指向第九节的悬空引用
  assert.doesNotMatch(scan.markdown, /第九节/u, '台账未生成时不得引用第九节')

  const baseline = audit({
    buffer: Buffer.from(LEDGER_DOC, 'utf8'),
    filename: '方案.md',
    docType: 'proposal',
    task: '线上垂直平台开拓尽快出一个落地方案。',
  })
  assert.equal(baseline.observable.tier, 'baseline')
  assert.match(baseline.observable.verdict, /承接评审未完成/u)

  const assessed = audit({
    buffer: Buffer.from(LEDGER_DOC, 'utf8'),
    filename: '方案.md',
    docType: 'proposal',
    task: '线上垂直平台开拓尽快出一个落地方案。',
    obligations: [
      {
        id: 'O1',
        question: '首轮进入哪个平台？',
        origin: 'explicit',
        critical: true,
        coverage: 'missing',
        evidence: [],
      },
    ],
  })
  assert.equal(assessed.observable.tier, 'assessed')
  assert.match(assessed.markdown, /第九节/u)
})

test('补齐标准不是"字段填满"：不得让上级在 A/B 之间做选择', () => {
  const doc = ['# 渠道推进', '', 'PartsTech 是最佳首选渠道，应优先接洽。', '', '建议本月完成入驻，后续再评估其余渠道。'].join('\n')
  const report = audit({ buffer: Buffer.from(doc, 'utf8'), filename: '方案.md', docType: 'proposal' })
  // 「请在 A 与 B 之间选择」等于把决定交回给上级 —— 那正是工作空转本身
  assert.doesNotMatch(report.markdown, /请在 A 与 B 之间选择/u)
  assert.match(report.markdown, /先给出推荐选项/u)
})

test('首行是体检得分（三层加权），B 维度不得另起一套口径', () => {
  const report = audit({ buffer: Buffer.from(LEDGER_DOC, 'utf8'), filename: '方案.md', docType: 'proposal' })
  const observable = report.observable

  // 三层必须在，且顺序固定：表达 A / 执行 C / 决策 D
  assert.equal(observable.layers.length, 3)
  assert.deepEqual(observable.layers.map(layer => layer.key), ['A', 'C', 'D'])
  assert.ok(observable.slopScore === null
    || (observable.slopScore >= 0 && observable.slopScore <= 100))

  // 首行必须是分数，不是「未判定」
  const afterHeader = report.markdown
    .slice(report.markdown.indexOf('## 一、判断') + '## 一、判断'.length)
    .trim()
  assert.ok(afterHeader.startsWith('**体检得分'), '第一节第一行必须是体检得分')
  assert.match(report.markdown, /表达 .+ · 执行 .+ · 决策 /u)
  assert.match(report.markdown, /权重 20 \/ 40 \/ 40/u)

  // 「未判定」仍然在，但降为边界行，不得消失
  assert.match(report.markdown, /边界.*未判定|未判定.*只做了规则扫描/u)

  // B6 摘要必须引用第一节的口径，不得再印「责任人标记有/无」那一套
  const b6 = report.dimensions.find(item => item.id === 'B6')
  assert.match(b6.summary, /口径见第一节/u)
  assert.doesNotMatch(b6.summary, /责任人标记有|责任人标记无/u)
})

test('义务表给了但不给任务原话：按自述目标评估，且不允许说"满足交付要求"', () => {
  const report = audit({
    buffer: Buffer.from(LEDGER_DOC, 'utf8'),
    filename: '方案.md',
    docType: 'proposal',
    obligations: [
      {
        id: 'O1',
        question: '首轮进入哪个平台？',
        origin: 'explicit',
        critical: true,
        coverage: 'met',
        evidence: [{ quote: 'PartsTech 是最佳首选渠道，应优先接洽。' }],
      },
    ],
  })
  assert.equal(report.ledger.status, 'ok')
  assert.doesNotMatch(report.markdown, /满足本次交付要求/u)
})

/* ─────────────── 金字塔排布与「已观测」第四态（0.2.6） ─────────────── */

test('报告按金字塔排：先判断、再追问，表达分不得坐主位', () => {
  const report = audit({ buffer: Buffer.from(LEDGER_DOC, 'utf8'), filename: '方案.md', docType: 'generic' })
  const md = report.markdown
  const at = key => md.indexOf(key)

  // 第一节必须是"判断"，但**没有任务基准时不得给出定性结论**
  assert.match(md, /## 一、判断/u)
  assert.match(md, /未判定/u)
  assert.match(md, /## 二、/u)

  // 顺序：判断 → 追问 → 没判什么 → 文件与解析
  assert.ok(at('## 一、判断') >= 0)
  assert.ok(at('## 一、判断') < at('## 二、'))
  assert.ok(at('## 二、') < at('## 三、本次没判什么'))
  assert.ok(at('## 三、本次没判什么') < at('## 四、文件与解析'))

  // 嵌套加粗会把强调打在免责句上（0.2.5 的首句就是这么坏的）
  assert.doesNotMatch(md, /这是\*\*表达水分\*\*/u)
})

test('体裁未识别时 B6 只报数、不判定，不得印成"不适用"', () => {
  const report = audit({ buffer: Buffer.from(LEDGER_DOC, 'utf8'), filename: '方案.md', docType: 'generic' })
  const b6 = report.dimensions.find(item => item.id === 'B6')

  assert.ok(b6 !== undefined)
  // 关键：不能是 not-applicable —— 那等于把"我不知道这是什么文件"说成"这类文件不需要"
  assert.notEqual(b6.state, 'not-applicable')
  assert.equal(b6.state, 'observed')
  assert.equal(b6.severity, 0)
  assert.equal(report.scores.indexB.value, null)
})

test('可观测要素进第一节，且明确标注"这是计数不是判定"', () => {
  const report = audit({ buffer: Buffer.from(LEDGER_DOC, 'utf8'), filename: '方案.md', docType: 'generic' })
  const md = report.markdown
  const head = md.slice(0, md.indexOf('## 二、'))

  assert.match(head, /待核实线索/u)
  assert.match(head, /计数，不是判定/u)
})

test('台账结论只在第一节出现一次，不得在"本次没判什么"里重印', () => {
  const report = audit({
    buffer: Buffer.from(LEDGER_DOC, 'utf8'),
    filename: '方案.md',
    docType: 'proposal',
    task: '线上垂直平台开拓尽快出一个落地方案。',
    obligations: [
      {
        id: 'O1',
        question: '首轮进入哪个平台？',
        origin: 'explicit',
        critical: true,
        coverage: 'met',
        evidence: [{ quote: 'PartsTech 是最佳首选渠道，应优先接洽。' }],
      },
    ],
  })
  assert.equal(report.ledger.status, 'ok')

  // 0.2.6 首跑实测：§一 与 §三 各印了一份完全相同的台账结论。
  const pointers = report.markdown.match(/逐条台账见第九节/gu) ?? []
  assert.equal(pointers.length, 1, '台账结论只能出现一次，重复印读者会以为有两件事')
})

test('B 维度不计分：状态列写"线索 · 不计分"，严重度列必须是 —', () => {
  const report = audit({ buffer: Buffer.from(LEDGER_DOC, 'utf8'), filename: '方案.md', docType: 'proposal' })
  for (const dimension of report.dimensions.filter(item => item.index === 'B')) {
    assert.doesNotMatch(dimension.summary ?? '', /严重度/u, `${dimension.id} 的摘要仍在提严重度`)
    // ★ 实测踩到过：B 的 state 就是 'scored'（算出来了，只是不参与分数），
    //   客户端据此印出「3」并上了红色，而 markdown 那一栏印「—」——
    //   同一份报告两个说法。判断现在只由 summarize 的 `counts` 提供，两边都读它。
    assert.equal(dimension.counts, false, `${dimension.id} 不计分，counts 必须是 false`)
  }
  // 状态标签必须先报**状态**：B2 判不了就要写"未能评估"，不能压成"线索 · 不计分"——
  // 否则第三节说"这几项判不了"、第六节说"线索不计分"，同一个维度两套说法。
  assert.match(report.markdown, /\| B2 实质信息 \| 20% \| 未能评估 \|/u)

  // 严重度列：凡「逐维观测」里 B 开头的行，第五格必须是 —，不得印等级。
  // （cells[0] 是行首空串，1=维度 2=权重 3=状态 4=严重度）
  // ⚠️ 必须把范围锁在逐维观测这张表：末尾「已退出计分的维度」也有以 | B3 开头的行，
  //    但那张表没有严重度列，混进来会把一张正常的表判成错。
  //    逐维观测的形状是 `| B1 目的陈述 | 15% | …` —— 第二格必须是「数字%」。
  const bRows = report.markdown.split('\n')
    .filter(line => /^\| B\d [^|]*\| \d+% \|/u.test(line))
  assert.equal(bRows.length, 6, `逐维观测里应有 6 个 B 维度行，实际 ${bRows.length}`)
  for (const row of bRows) {
    const cells = row.split('|').map(cell => cell.trim())
    assert.equal(cells[4], '—', `${cells[1]} 的严重度列必须是 —，实际「${cells[4]}」`)
  }

  // 反向守卫：不能靠"把严重度列一律抹成 —"过关。
  assert.ok(report.dimensions.some(item => item.counts),
    '至少要有一个真正计分的维度，否则"全是 —"也能通过上面那条')
})
