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
> | Source | ✅ implemented (10 host modules + 2 client modules + 4 scripts + 6 test files) |
> | `npm run build` / `test` / `verify` | ✅ **180 / 180 tests pass**; release-contract check passes; `lib/` matches source |
> | Running inside DSH | ✅ at 0.3.11 — settings panel opens, 6 tools registered, text input verified end-to-end |
> | npm publish | ✅ `@yiyunet/dsh-kill-ai-slop` |
> | **Settings panel UI** | ⚠️ still the old single-index view — the four layers are available via the report markdown, tool params and RPC; the panel form is planned for 0.5.1 |
>
> Proven: the code is internally consistent, the release shape is complete, and the **host contract holds**.
>
> ### 🚨 0.5.0 is a breaking change: the score direction flipped
>
> | | 0.3.x | 0.5.x |
> |---|---|---|
> | Meaning | **higher = worse** (100 = pure slop) | **higher = better** (100 = this stage's required work is done) |
> | Layers | expression 20% / execution 40% / decision 40% | intent 20% / strategy 35% / execution 35% / expression 10% |
> | Who scores | the engine computed severity from word lists | **a human/agent supplies 0–4**; the engine only produces evidence, does the arithmetic, and draws the conclusion |
>
> **Scores are not comparable across versions.** Never display them side by side without the direction caveat.
>
> The new model asks four questions: *What task was taken on? What choices were made?
> How is it going to be carried out? Can the reader actually use it?*
> The unit of judgment is **unfinished required work**, and every deduction must pass a four-condition gate
> (required this stage / the submitter's job or their job to prepare the input / genuinely not done in the whole document /
> affects a current decision or action). Deductions that fail the gate are demoted to suggestions, never deleted.

---

## Install

Where it lands depends on **how you open DSH**. The two are independent — installing into one does not show up in the other.

### ① Browser GUI (`dsh web` / `dsh --profile web`)

```sh
dsh plugin --profile web add @yiyunet/dsh-kill-ai-slop
```

### ② Desktop client

**Do not use the command above.** The desktop app ships its own runtime; plugins land in the reserved
`$DSH_HOME/profiles/desktop` and are managed by the client itself — install by package name from its plugin window.

Give it the **package name** `@yiyunet/dsh-kill-ai-slop`, not a GitHub URL: a git source requires the host
to run the package's build script, which hardened environments refuse outright
(`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`).

### Confirm it loaded

Either way, check `cordis.patch.yml` (the package patch normally injects it):

```yaml
- insert:
    - id: kill-ai-slop
      name: '@yiyunet/dsh-kill-ai-slop'
```

Restart the Host → open **Settings** → **AI垃圾过滤** appears on the left.

> The build output `lib/` is committed to this repository, so **an npm install needs no build step**.
> A git install does require running `scripts/build.mjs`, which most managed environments do not allow — hence npm.

---

## Two words: AI Slop and Work Slop

The two words in the name are the two starting points of the scoring
(both are **public vocabulary** — the three upstream projects are about exactly these):

| Term | What it means | Index here |
|---|---|---|
| **AI Slop** | Text that looks like content but carries none: filler, repetition, templated phrasing, vagueness, paragraphs that do not advance | Expression (A) — 20% |
| **Work Slop** | Pushing the thinking and the tidying that should have been done onto the reader: no purpose, no evidence, no owner, no deadline | Execution (C) + Decision (D) — 80% |

What they share: **neither asks "who wrote it" — both ask "how much effort does this file push onto you."**
That is why this plugin guesses no author and reports no "AI probability".

> Why execution and decision carry 80%: a terse but fact-rich report is merely *not pretty*;
> a proposal with no purpose, no support and no owner gets sent back for rework —
> **that is the real cost.**

---

## Why not a single "AI rate"

Most tools hand you one number: *"87% likely AI-written."* Two problems:

- **Style is not evidence of authorship.** A hollow human-written doc and a high-quality AI-assisted technical report can both "not sound like a person".
- **It answers the wrong question.** You want to know *can I use this file*, not *who wrote it*.

So this plugin reports **one** auditable score, 0–100 (higher = worse) — never a probability, and never a guess about authorship:

| Index | Question | Dimensions |
|---|---|---|
| **Expression (A)** — weight 20 | How much reading cost produced no information | filler, repetition, templates, vagueness, paragraphs that do not advance |
| **Execution (C)** — weight 40 | Does the deliverable say who does what, by when, in what shape | owners, deadlines, next-step form |
| **Decision (D)** — weight 40 | Does the deliverable say what was chosen, what was dropped, and on what evidence | options, trade-offs, basis |

**The three are weighted into a single 体检得分 (0–100, higher = worse).** Execution and decision carry 80% because this plugin targets *work slop*, not prose style — a terse but fact-rich technical report must not be judged bad for "not reading like prose".

> Weights `20 / 40 / 40` are **provisional and uncalibrated**. A steering wheel, not a ruler for performance reviews.

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
3. **Office / PDF parsing is structural, not layout-faithful** — PDF goes through a heuristic path (font maps, column order and tables may be wrong; marked `pdf-heuristic` with lowered confidence); `docx` / `xlsx` are read from OOXML structure, so headers, footers, text boxes, charts and comments may not be picked up. **Coverage reported in the output is the authority.**
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

## Feedback

Found a problem or want a new feature? [Open an issue](https://github.com/yiyunet/dsh-kill-ai-slop/issues/new/choose).
Include the **DSH version** and the **plugin version** — that makes a fix much faster.

For "the verdict is wrong", the most useful thing is **the exact sentence from the source** plus the score
the plugin gave. **Remove private info and keys before pasting** — this tool reads other people's documents,
so full text is usually riskier than an excerpt.

---

## License

[MIT](LICENSE). Methodology informed by `stop-slop`, `no-ai-slop` and `kill-ai-slop`;
**no code was copied**. Per-item "adopted / not adopted and why" is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

<div align="center"><b>It judges the file, not the author.</b></div>
