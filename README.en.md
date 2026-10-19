<div align="center">

<img src="assets/logo.svg" width="72" alt="Kill AI Slop">

# Kill AI Slop

**Score what you received, then extract what actually matters.**

`@yiyunet/dsh-kill-ai-slop` · DSH plugin · zero dependencies · offline · nothing uploaded

</div>

---

> ### Status (read this first)
>
> | Item | State |
> |---|---|
> | Source | ✅ implemented (8 host modules + 2 client modules + 4 scripts + 4 test files) |
> | `npm run build` / `test` / `verify` | ✅ **77 / 77 tests pass**; 12 contract assertion groups pass |
> | Running inside DSH | ✅ **yes (v0.3.6)** — settings panel opens, 6 tools registered, text input verified end-to-end |
> | Real-file regression (docx / pdf / xlsx real files) | ⬜ not done — only `.md` / `.txt` and self-made fixtures so far |
> | Blind-set calibration (weights & thresholds) | ⬜ not done — current values are proposals |
> | npm publish | ⬜ not done |
>
> Proven: the code is internally consistent, the release shape is complete, and the **host contract holds**.
> Not proven: parsing real Word / PDF files, and that the scores are accurate (zero calibration).
> So `dsh plugin add` **still does not work** (package not published), and claims such as
> "supports Word/PDF" or "accuracy X%" must not be made until the real-file row turns green.

---

## Two words: AI Slop and Work Slop

The two words in the name are the two starting points of the scoring
(both are **public vocabulary** — the three upstream projects are about exactly these):

| Term | What it means | Index here |
|---|---|---|
| **AI Slop** | Text that looks like content but carries none: filler, repetition, templated phrasing, vagueness, structural noise | Expression bloat (A) |
| **Work Slop** | Pushing the thinking and the tidying that should have been done onto the reader: no purpose, no evidence, no owner, no deadline | Work offloading (B, primary) |

What they share: **neither asks "who wrote it" — both ask "how much effort does this file push onto you."**
That is why this plugin guesses no author and reports no "AI probability".

> Why B is primary: a terse but fact-rich report is merely *not pretty*;
> a proposal with no purpose, no support and no owner gets sent back for rework —
> **that is the real cost.**

---

## Why not a single "AI rate"

Most tools hand you one number: *"87% likely AI-written."* Two problems:

- **Style is not evidence of authorship.** A hollow human-written doc and a high-quality AI-assisted technical report can both "not sound like a person".
- **It answers the wrong question.** You want to know *can I use this file*, not *who wrote it*.

So this plugin reports two separate indices, both 0–100 (higher = worse), neither a probability:

| Index | Question | Dimensions |
|---|---|---|
| **Expression bloat (A)** | How much reading cost produced no information | filler, repetition, templates, vagueness, useless structure |
| **Work offloading (B)** | Did the author push the thinking onto you | purpose, substance, support, consistency, decision support, execution |

**B is the primary index; A is secondary. They are never averaged.** A terse but fact-rich technical report must not be judged bad for "not reading like prose".

---

## Use it

Settings → **AI垃圾过滤** (`settings.section`, `order: 23`):

1. Drop a file, or paste text;
2. pick a **document type** (this is an applicability switch, not a style option);
3. press **开始体检** (run audit);
4. read four tabs — overview / evidence / distillation / raw Markdown.

Nothing leaves the machine: the browser hands the bytes to the local DSH host process, which scores them in memory.

### Tools

| Tool | Purpose |
|---|---|
| `slop_engine_info` | self-check: engine version, supported formats, which gates are closed |
| `slop_audit_text` | full audit of a text string |
| `slop_audit_file` | audit a host-side file — **disabled by default**, requires `inputRoots` |
| `slop_distill` | five-element fidelity extraction only (no scoring) |
| `slop_obligation_audit` | **obligation ledger** — you supply the obligations and judgements, the plugin machine-verifies every quote against the source |
| `slop_verify_quotes` | quote check only: does this sentence exist in the source, and on which line |

> **The ledger is the v0.2 flagship.** Work Slop is the *gap* between what the task asked for
> and what was delivered — a difference of two operands. One document alone cannot express it,
> so this path requires the original task text plus the document.
>
> Division of labour is deliberate: the model (you) decides what is missing; the plugin only
> checks whether the evidence exists. It never judges whether a conclusion is right, only whether
> the quote is real. Line numbers and citations are exactly where models fabricate, and exactly
> where a rule engine is 100% reliable.


---

## Supported files

| Format | How | Notes |
|---|---|---|
| `txt` `md` `csv` `json` `log` `yaml` `html` `rtf` | direct | UTF-8 / UTF-16 BOM first, GBK fallback |
| `docx` `pptx` `xlsx` | own ZIP + OOXML reader | body text only; headers, footers, notes, embedded objects excluded (reported) |
| `pdf` | content-stream inflate + text operators | **heuristic**: no OCR, no font encoding maps |
| `doc` `xls` `ppt`, archives, images, `eml` | unsupported | the error tells you how to re-export |

**No OCR.** A scanned PDF yields "coverage insufficient" and **no total score**, rather than a fake one.

---

## Fidelity-first extraction

Five elements — purpose / exposition / claims / stance / execution — plus evidence-and-limits and must-ask questions.

**It is extractive, never generative.** Every line is a verbatim span of the source with a line number, so you can check it character by character. The trade-off is deliberate: output reads less smoothly than a human summary, but it can never turn *"expected to cut cost, no test data yet"* into *"cuts cost"*.

Numbers, dates, owners, commitments and conditional outcomes are **hard-protected**: they are force-included at every compression level. Retention is guaranteed structurally, not checked after the fact.

Three levels: integrity (structure kept) / summary (default, reorganised by element) / card (≤3 lines per element, explicitly "not a substitute for the original"). Every level reports what was dropped and why.

---

## Configuration

```yaml
- insert:
    - id: kill-ai-slop
      name: '@yiyunet/dsh-kill-ai-slop'
      config:
        maxFileBytes: 20971520
        maxRpcBytes: 12582912
        maxChars: 600000
        minParseCoverage: 0.7      # below this → no total score
        minEvalCoverage: 0.6       # below this → score marked partial
        includeSnippets: true
        reportRoot: ''             # set to enable "save report"
        keepRecent: 20
        # inputRoots: ['/abs/path']
```

---

## Known limits

1. **No OCR** — scanned PDFs are reported as insufficient coverage, not scored.
2. **No authorship detection** — no "AI-generated probability". Style is not evidence.
3. **PDF extraction is heuristic** — font maps, column order and tables may be wrong; marked `pdf-heuristic` with lowered confidence.
4. **No semantic understanding** — rules are symbolic (lexicons, structure, numeric consistency). They cannot catch "fluent but wrong".
5. **Weights and thresholds are proposals (E-tier)** — uncalibrated. Suitable for triage, **not** for external conclusions or performance review.
6. **Chinese and English share one threshold set** — language-specific calibration not done.

---

## Development

```sh
npm run doctor     # preflight: Node version, GBK support, file presence, zero deps
npm run build      # plugin-src/ → lib/ (no bundler, no build dependency)
npm test           # node --test, tests the source not the artifacts
npm run verify     # 11 release-contract assertions
npm run check      # all of the above
```

`plugin-src/` is the single source of truth; `lib/` is generated.
Changing rules ⇒ bump `RULESET_VERSION`. Changing the pipeline ⇒ bump `ENGINE_VERSION` (must match `package.json`).
Not bumping means old and new scores get compared as if they were the same thing.

Maintainers: read the "five design decisions you should not casually change" section in [`CONTEXT.md`](CONTEXT.md).

---

## License

[MIT](LICENSE). Methodology informed by `stop-slop`, `no-ai-slop` and `kill-ai-slop`;
**no code was copied**. Per-item "adopted / not adopted and why" is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

<div align="center"><b>It judges the file, not the author.</b></div>
