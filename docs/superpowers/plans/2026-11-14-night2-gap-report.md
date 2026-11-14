# Night-2 gap report — acceptance scoring of the merged tree

**Scored:** 2026-11-14 · **Head:** `efa1d636596c6ac7adb80eed1ee0b05cbd7a4cec` (`feat/night-2`, 60 commits
ahead of `public/main`, working tree clean) · **Scorer:** read-only agent, source untouched.
**Checklist:** `2026-11-14-engineering-checklist-night2.md`, all 151 rows rewritten to exactly one of
`true (test: …)` / `false (…)` / `untestable here (…)`.

## 0. Gates, measured on this head

| Check | Result |
|---|---|
| `npm --prefix os-ui test` | **exit 0** — 6234 tests, 6228 pass, **0 fail**, 6 todo, 84.3 s |
| `node scripts/check-structure.mjs` | **exit 0** — "ok (no new violations)" |
| ratchet | `TAB-ISOLATION 419` (at baseline) · `LEGACY-IMPORT 1` (at baseline) · `CORE-INDEPENDENCE 200` (at baseline) · `FILE-HEADER 1233` (baseline 1235 — **2 fewer**, deliberately not relocked) |
| `bash os-ui/scripts/gate.sh` | **exit 0** — 436 tests, 432 pass, 0 fail, 4 todo |
| `bash scripts/license-check.sh` | **exit 0** — PASS, 47 bundled components, no new SPDX id, 1 pre-existing informational syft warning; both version floors hold |
| stray `* 2.*` files | none (searched the whole worktree outside `node_modules`) |

No baseline is higher than at the start of the programme and one is lower. **X10 is the row only a
scorer can flip, and it is now `true`.**

The 6 `todo` tests: 3 in `tabs/agents/lib/build/os-tools.test.ts` (resource narrowing ×2, held-action
args), 1 in `core/infra/os-mirror.test.ts` (mirror durability), 2 in
`tabs/agents/lib/git/coin-test.test.ts` (the `dataset` row — now redundant, see §3 item 16).

## 1. Score table

| Stream | true | false | untestable here | rows |
|---|---|---|---|---|
| M — metrics as dbt metrics | 6 | 8 | 2 | 16 |
| D — Superset-class dashboards | 12 | 9 | 0 | 21 |
| C — chat to the data | 10 | 6 | 0 | 16 |
| S — software, hosted properly | 8 | 9 | 0 | 17 |
| G — git everywhere, made visible | 4 | 6 | 0 | 10 |
| T — the engineering view | 8 | 2 | 1 | 11 |
| E — the engineer's door | 8 | 2 | 2 | 12 |
| V — lifecycle Studio→Test→Run | 11 | 2 | 1 | 14 |
| X — cross-cutting | 9 | 2 | 1 | 12 |
| H — the app-building harness | 22 | 0 | 0 | 22 |
| **Total** | **98** | **46** | **7** | **151** |

29 of the 46 `false` rows are `[later]`/backlog rows that were never started tonight. Of the **122
rows the programme actually aimed at: 98 true, 17 false, 7 untestable here.**

### The scoring rule I applied, stated so a re-scorer can disagree with it

A row is `true` only when I opened the test file named in its Status, read the assertions, confirmed
they assert *that row's* claim (not a neighbour's), and found the test among the 6228 passes of my own
suite run. Doc text, source comments and stream reports counted for nothing.

Where a declared deviation exists I split it two ways, because the distinction decides eight rows:

- a deviation that **preserves the guarantee the row exists for** keeps the row `true`, with the
  deviation named in the Status — e.g. **T4** (the Dagster link is not the `/tools` proxy path because
  the proxy renders Dagster blank; the link still resolves, is role-gated, and says why when it
  cannot) and **V12** (the pin file is `os/lifecycle/pins.yml`, not a flat `os/lifecycle.yml`; it is
  still committed, clone-readable and push-rejected).
- a deviation that **weakens that guarantee** makes the row `false` — e.g. **M6** (the row says
  `cumulative` and `derived` are refused; the code deliberately serves both) and **V3** (the row says
  `go_live` writes a git tag; `res.tag.written` is asserted `false`).

A row whose only unproven half needs a cluster, a browser or a live model is `untestable here`, with
the exact command that would prove it. A row with **both** a code gap and an environment gap is
`false` — the code gap dominates.

## 2. Every `false` row, and the smallest change that flips it

Backlog rows (`[later]`, never started) are listed at the end without a fix, because the fix is "build
the feature".

| Row | What is missing | Smallest change that flips it |
|---|---|---|
| **M6** | `tabs/metrics/lib/dbt-metric.test.ts` asserts the *opposite* of the row: `serveRefusal(d, window, matched) === null` and `previewTrinoSql(...)` returns SQL, so a `cumulative` metric at its own grain IS served, and `derived` one level deep is served too. | **Rewrite the row**, not the code. Deviation M-1 is right (removing a working number regresses every dashboard built on one). The row should say: a shape the compiler cannot serve *for this slice* is a typed named refusal; `cumulative` is served only at a matching grain and carries the bucket-vs-calendar warning; `derived` is served one level deep. ~10 min, doc only. |
| **M7** | `archiveMetric` / `unarchiveMetric` / `moveMetric` (`tabs/metrics/lib/lifecycle.ts:148,212,219`) write only `writeFlag`/`setFlag` into the `osMirror` overlay and reach no commit primitive; "promote" has no metric-shaped commit either. Define / upsert / label / remove are proven. | Design question, not a one-liner: the lifecycle overlay is deliberately *not* in the dbt project, so there is nothing in the generated tree for an archive to change. Either promote the overlay to a committed `os/` file (then these three commit for free) or narrow the row to the four writes that own files. **Morning.** |
| **M8** | `define_metric` parity is real (10th `X8 parity` case). `promote_metric` has no case: no extracted service function, the route cannot be imported by a test, and the UI half lives in `@tabs/metrics` which a `tabs/data` test may not import. | Extract `promoteMetricService(user, metricId, target)` in `tabs/metrics/lib/governance.ts` and add a parity case in a new `tabs/metrics/lib/mcp-parity.test.ts` driving both doors. ~45 min. |
| **M11** | `tabs/metrics/lib/explorer.ts:157` escapes filter values by doubling quotes rather than binding them, and lines 158/228/263 interpolate the member leaf, every dimension leaf, `measure.name` and `spec.granularity` straight into SQL with **no local allow-list check** — `assertColumn` exists only at define time (`model.ts:103`). | Move the gate to the boundary ARCHITECTURE.md says owns it: `assertColumn` on every leaf and on `measure.name` inside `previewTrinoSql`/`windowTrinoSql`, `PANEL_TIME_GRAINS` on `spec.granularity` *there* rather than only at the dashboards door, and bound parameters for filter values. ~1.5 h. **Morning** — see §4, this is the highest-severity code finding after `sanitizeIdent`. |
| **M12** | `governMetric` (`tabs/metrics/lib/governance.ts:70-79`) applies role + `consistencyCheck` and nothing else, so a metric can be promoted above its dataset's tier. The lane move itself is proven. | One guard in `governMetric` comparing the target tier to `record.dataset.tier` and refusing with the dataset named, plus one case in `governance.test.ts`. **~25 min — do it tonight.** |
| **M13** | `honest-text.test.ts`'s `TREES` is `['tabs/metrics','core/mcp']`; the row names `tabs/dashboards` too, and 27 Cube claims remain there: `guide.md:5,13,22,27,42`, `context.md:3,10`, `lib/README.md:10,12,22,23,24,27`, plus ~14 comments in `ui/DashboardBuilder.tsx`, `ui/DashboardGrid.tsx`, `ui/PanelChart.tsx`. | Delete the 27 claims and add `'tabs/dashboards'` to `TREES`. Pure prose, no behaviour risk. **~30 min — do it tonight; it flips M13 and X9 together.** |
| **D12** | Each degradation has its own case and the new M-9 path is covered, but nothing asserts the **precedence**: the `??` chain at `tabs/dashboards/lib/build/panel-query.ts:214-218` is unpinned, no test has two degradations co-occurring, the outage branch has no case in that file, and a tree-wide grep finds no precedence test anywhere. | One test in `panel-query.test.ts` with an outage **and** an unresolved member **and** a dropped dimension, asserting the outage sentence wins; then drop one condition at a time. No production change. **~15 min — do it tonight.** |
| **S8** | The *enforcement* half is real (`app-tool-call.test.ts` drives `callAppTool`: no port ⇒ 403 at the `adoption` layer, adopted read ⇒ executed, adopted write ⇒ 202 held, ungranted ⇒ 403 at `grant`). The *registration* half is false: app-declared actions never enter `list_adoptable_actions`/`adopt_entity_actions`, which is the connections-exposure path (`core/mcp/experimental/exposure-write-tools.ts:343,376`) and knows nothing about `parseAppActions` — a grep for `parseAppActions`/`appActions` under `tabs/agents/` and `core/mcp/` returns nothing. | Design work: an app exposure is not a connection exposure, so `list_adoptable_actions` needs a second source or a sibling tool. **Morning.** |
| **S9** | `dataset-guard.ts:71` is `ungrantedDatasetWarningForApp` — a *string*, consumed as a warning at `review.ts:353` and `server.ts:152`; `dataset-guard.test.ts` asserts the warning text. Nothing refuses. Lifecycle rules are not in this path either. | Decide whether an ungranted reference becomes a 422 at commit. Turning a warning into a refusal can block an in-flight build, so it is a posture decision, not a patch. **Morning.** |
| **G2** | `GIT_OBJECT_LAYOUT` was corrected at merge, but **no test compares it to `docs/components/git.md`**, and the markdown is now wrong in four rows: line 40 calls the dashboard writer "landing" (committed), line 39 says the metric emitter "lands with the metrics work" (landed), line 42 names `tabs/software/lib/git/commit.ts` — **a path that does not exist**, the module is `tabs/software/lib/git-commit.ts` — and promises `.app/release.json` + `app/<slug>/v<x.y.z>` tags S11 did not land, and line 43 says lifecycle pins live in `os/lifecycle.yml` with tags written by `core/kernel/lifecycle.ts`, when the file is `os/lifecycle/pins.yml`, the writer is `core/infra/lifecycle-pins.ts` and **no tag is written at all**. | Correct the four rows and add a tripwire to `git-objects-kinds.test.ts` that parses the markdown table and deep-equals it against `GIT_OBJECT_LAYOUT`. **~20 min — highest truth-per-minute on this list: the page an engineer is told to trust currently gives the wrong path for lifecycle pins and names a module that is not there.** |
| **G3** | `instrumentation.ts:493-526` registers exactly three resolvers — `agent-system`, `software`, `dashboard`. `dataset`, `metric` and `lifecycle-pin` all have **committed writers and real files in the tree** and answer the typed 501 `kind_not_wired` (`git-objects.ts:425-443`). `tabs/metrics/lib/git-object.ts` exports `metricGitLocation` and nothing calls `registerGitObject('metric', …)`. | Three resolvers + three lines in `instrumentation.ts`. `dataset` and `lifecycle-pin` are cheap (the paths are already in `GIT_OBJECT_LAYOUT`); `metric` needs a governed read returning `{domain, semanticModel, ownerUid}`. **~45 min for all three, or ~20 min for the two cheap ones. Flips G3 and G7 together.** |
| **G6** | `core/ui/git/` provides the components with all logic in `git-view.ts` (10 tests) and the Agents header is unified onto the shared badge, but a tree-wide grep finds `GitHeadBadge` in only two tab surfaces (`tabs/agents/ui/SystemView.tsx`, `tabs/software/ui/SoftwareBuilder.tsx`) plus `core/ui/engineering/UnderTheHood.tsx`. Data, Metrics and Dashboards do not mount it. | Three one-line mounts. **~25 min — do it tonight, in the same pass as E10.** |
| **G7** | Parity is real (`core/mcp/git-tools.test.ts` asserts deep equality with the drawer's module per read). "Work for every kind" fails for G3's reason: five of eight kinds answer 501. | **The same fix as G3** — one change flips both. |
| **G9** | `[later]`. `restoreVersion` landed and is tested against a real writer with the prior history byte-identical, but no tab registered a restorer, so every kind answers `restore_unsupported` and `restore_version` is deliberately out of the MCP catalogue (deviation G-2). | Register one restorer (agent-system is the natural first) and add it to the catalogue behind the normal gates. Backlog by design. |
| **G10** | `[later]`. Governance → Repositories landed admin-only with 8 + 3 tests, including hydrate-before-read and the per-row visibility filter. The second half is false: `core/ui/git/ReleaseList.tsx` is **hidden** because no annotated-tag API exists (S11). Not browser-verified either. | Blocked on S11 (`release_software`). Backlog. |
| **T10** | `[later]`, deliberately. No adapter emits a `trino` or `litellm` section: both are declared in `ENGINEERING_TOOLS` (`core/engineering/types.ts:23`) with vocabulary entries (`vocabulary.ts:26,37`) and **no producer** — this is the "unused tool" item carried from the merge. A preview button without the query budget was judged a live incident. | Build the two sections *with* the budget, or drop `trino`/`litellm` from `ENGINEERING_TOOLS` until then so the enum has no dead members. Backlog. |
| **T11** | `[later]`. The agent-system export is documented as two files + `git clone`; the dashboard/app exports and the `list_capabilities` description sweep are untouched. | Backlog. |
| **E10** | The builder is right and tested (`core/infra/git-clone.test.ts` pins the URL, HTTPS-only with loopback excepted, the blob-API file link, and "nothing rather than half a command") — but `core/ui/git-clone/CloneRepository.tsx` is mounted on **no page**: a tree-wide grep returns only the component and `core/infra/git-clone.ts`. | Five one-line mounts (`<CloneRepository domain={…} filePath={…} />`) on the Data, Metrics, Dashboards, Software and Agents detail headers. **~20 min — do it tonight, same pass as G6.** |
| **E12** | `[later]`, unchanged. Branches as proposals, PR-like review, the remaining kinds, apps by push, VS Code snippets — all named in `docs/components/git.md` → "What is NOT true yet", none in the tree. | Backlog. |
| **V3** | `core/kernel/go-live.test.ts` asserts `res.tag.written === false` — **no git tag is written for any kind**, and no SemVer release tag for apps, which is half of what the row says `go_live` does. The pin file is also `os/lifecycle/pins.yml`, not the flat `os/lifecycle.yml` (deviation V-2, a rename, not a weakening). | Call S4's `annotatedTag` from `goLive` — it landed tonight and has **no caller**. ~30 min, but it is a new write on the operate path, so **morning**, with the immutability (409 on re-release) exercised. |
| **V14** | `[later]`. No `__dev` schema, no lifecycle-conditioned Dagster schedule generation, no preview/staging/prod mapping. | Backlog. |
| **X9** | True for the surfaces X owns (`core/mcp/cube-honesty.test.ts`, nine patterns including the bare `cube:` key, with a no-op guard). The row says "anywhere in the tree" and `tabs/dashboards/**` still carries 27 claims. `tabs/software/**` is clean. | **The same change as M13** — one pass flips both. |
| **X11** | Every obligation but one is discharged and tested, and `license-check.sh` is green. The **SBOM is not**: the committed `sbom.cdx.json` carries a path from a *different* agent worktree — `/.claude/worktrees/agent-a19a83bee683562a5/os-ui/package-lock.json` — so it was generated from a dirty tree, and it lists **no `echarts` component at all** (137 components, zero matches), the same X-2 gap on the one surface nobody fixed. | Add `--exclude './.claude/**'` to **both** syft lines (`scripts/license-check.sh:88,92`) and regenerate from a pristine clone. ~20 min, but it needs a clean clone, so **morning**. |

Backlog rows scored `false` with no fix listed because the fix is the feature:
**M15, M16** · **D14–D21** · **C11–C16** · **S11–S17**.

## 3. The carried open items, re-verified against this tree

| # | Item | Status on `efa1d636` |
|---|---|---|
| 1 | 13 platform MCP writes not in the hold table | **OPEN.** `core/mcp/write-tool-meta.test.ts:29` — `PLATFORM_WRITE_TOOLS = { commit: 'software', push_app_files: 'software' }`. `create_software`, `request_deploy`, `start_preview`, `promote`, `archive`, `delete`, `set_app_spec`, `design_software`, `decide_deploy`, `use_connection`/`use_data`/`use_knowledge`/`use_as_data` are absent from `WRITE_TOOL_TABS` and therefore **never held by any preset**. The test's own header records this honestly, which is why it is visible at all. Adding them moves the shipped Software Delivery Team's posture and the frozen engine goldens. |
| 2 | `sanitizeIdent` collapses `a.b`/`a-b`/`A_B` | **OPEN, and the most serious item in this report.** `tabs/data/lib/store-fqn.ts:38-41` is `value.toLowerCase().replace(/[^a-z0-9]+/g,'_')`, so `personalSchema('a.b')`, `personalSchema('a-b')` and `personalSchema('A_B')` all return `personal_a_b`. Two distinct principals therefore **share one Trino personal schema**, and the dbt generator writes `models/personal/<sanitised>/`, so their generated files collide in the repo too. See §4. |
| 3 | SBOM contains worktree paths | **OPEN.** Confirmed above (X11). The path is from `agent-a19a83bee683562a5`, i.e. an earlier agent's worktree, so the committed SBOM has never been regenerated cleanly. Neither syft line carries an exclude. |
| 4 | Creators cannot create git access tokens | **OPEN, and it contradicts E1.** `POST /api/git/tokens` (`app/api/git/tokens/route.ts`) has **no role floor** — any signed-in user may mint one — but `tabs/admin/lib/sections.ts:64` gates the Access-tokens screen at `minRole: 'builder'`, so a creator cannot reach the only UI that shows the token once. E1 says "read is unconditional; anyone with access to a domain can clone". Fix is one word (`'builder'` → `'creator'`), but it is a posture decision, so it is a morning item. |
| 5 | Trino client authentication absent (rules bootstrap inert) | **OPEN.** `core/kernel/config.ts:513` defaults `trinoAuthMethod` to `'none'` and the chart has no value for it — `docs/components/trino.md:183-184` says so in as many words. |
| 6 | `tab:assistant` → `tab:ask`; `complete.ts` still hardcodes it | **OPEN.** `core/runtime/complete.ts:93` sets `tab: 'assistant'` (and `:115` tags `'assistant'`) while `core/runtime/agent-loop.ts:294` defines `ASK_COST_TAB = 'ask'`. The builder's LLM spend therefore lands on a cost dimension nothing reads. One-line rename, but it moves a cost series, so note it before changing it. |
| 7 | V-12 badge, V-14 digest ref, V-15 503 on a fresh laptop | **OPEN by design, all three now asserted rather than assumed.** `core/ui/lifecycle/lifecycle-cache.test.ts` carries a per-kind row reading "the badge is deliberately not mounted" for Software and Knowledge; `tabs/dashboards/lib/lifecycle-adapter.test.ts` "the lifecycle ref is a content digest" pins V-14; `core/infra/lifecycle-pins.test.ts` "with NO source answering … every WRITE refuses" pins the 503. These are documented deviations, not gaps — V8 is `untestable here` for the browser half only. |
| 8 | D M-8 domain-move attribution | **PLUMBING CLOSED by `97692a39`, TEST STILL MISSING.** `tabs/admin/lib/domain-move.ts:116,126,154,160` threads `user.id` as `actorId` and audits `{actor, role}`, and `tabs/dashboards/lib/store.ts:131-133` warns when `actorId` is absent. But no test pins the acting admin end to end: `tabs/dashboards/lib/git/commit.test.ts:216` passes `actorId: 'system'` literally. **One-line test fix:** assert `(await log('finance'))[0].author.email` is the acting admin's. |
| 9 | M review L-2/L-5/L-7 texts lost → re-review `semantic/*` and `tabs/metrics/*` | **Done by me; findings in §5.** |
| 10 | `git-http:1.0.0` not built/pushed | **OPEN.** This is why E1 is `untestable here` rather than `true`; E must stay undeployed until the image exists. |
| 11 | M15 oracle: NULLIF divisor asymmetry | **OPEN, recorded.** `tabs/metrics/lib/dbt-metric.test.ts` "M-R2.4" pins the `NULLIF` wrap as deliberate. Any future MetricFlow differential must exclude zero-denominator rows or state the difference. M15 stays `false` (backlog). |
| 12 | S-9 residual: a hostile same-origin app omitting the intent headers | **OPEN, and the test says so out loud.** `core/kernel/app-intent.test.ts` "GUARD: the OS UI's own call — neither header — passes, and the limit is DOCUMENTED". An app that simply sends neither header is indistinguishable from the OS UI. Fix is the null-origin frame + postMessage RPC — architectural, morning or later. |
| 13 | `metric` kind: committed writer, no registered reader | **OPEN.** This is exactly why G3 and G7 are `false`; `tabs/metrics/lib/git-object.ts` is written and unwired. |
| 14 | Pushed metric YAML: agg/expr/filter reported not applied | **OPEN as described** (M's `IngestedMetric` lacks `agg`); the display-label path works. Not a checklist row of its own — carried to the morning with M7/M8. |
| 15 | E receive gate skips `agents/index.yml` ids unknown to the registry | **OPEN by design**, and right: an empty-hydrated registry is the September-2026 outage shape. Recorded, not a gap. |
| 16 | 6 todo tests | **OPEN**, and **2 of the 6 are now dead weight.** `tabs/agents/lib/git/coin-test.test.ts:250-263` holds a hardcoded `blocked` `dataset` row with no-op hooks, so it reports `todo` by construction even though E's ingest landed and the real dataset coin test is **green** in `tabs/data/lib/dbt/ingest.test.ts`. Wire the row to `ingestDbtModels` or delete it in favour of the data-tab test. The other 4 are pre-existing Phase-1/2 markers. |
| 17 | `tabs/dashboards/guide.md` ~5 Cube refs the tripwire does not match | **OPEN, and wider than reported: 27 refs across the tab, not ~5.** File-and-line list in the M13 row above. |
| 18 | `push_app_files` classified as a software write; `read-only` holds it; no golden moved | **CONFIRMED CLOSED.** `write-tool-meta.test.ts` pins it in `WRITE_TOOL_TABS` in both directions and asserts it is held-eligible; the shipped team grants `commit` and not `push_app_files`, and the frozen golden test ("the run matches the frozen golden tool-call sequence") is green, so no engine golden moved. One gap worth a line: there is no explicit `holdDecisionFor('read-only','push_app_files')` assertion, only table membership. |
| 19 | FILE-HEADER 1233 vs baseline 1235 | **CONFIRMED, not relocked.** My run reports `FILE-HEADER: 1233 (baseline 1235) — 2 fewer; run --baseline to lock it in`. H15's own Status claimed 1235 at baseline; I corrected that number in the checklist. |

## 4. The one item I would wake someone up for

**`sanitizeIdent` is not collision-free, and it names a security boundary.**
`tabs/data/lib/store-fqn.ts:38-41` maps every non-alphanumeric run to `_` and lower-cases, so
`a.b`, `a-b`, `a_b`, `A_B`, `a..b` and `a-.b` all become `a_b`. `personalSchema()` builds
`personal_<that>` and the dbt generator builds `models/personal/<that>/`. The personal lane is the one
place the OS promises is yours — `core/infra/git-receive.ts` refuses a push into someone else's lane,
and `git-receive.test.ts` "a personal lane two principals share is WITHHELD, not granted to either"
shows the push door already knows this collision is possible. The Trino side has no such withhold: two
principals whose ids differ only in punctuation or case read and write **the same Iceberg namespace**.

It is not a night fix — it needs a collision-free encoding (a short hash suffix on anything that is not
already a clean identifier) plus a migration of existing schemas and committed lane directories. It
belongs at the top of the morning list, above every checklist row.

## 5. My own review of `tabs/data/lib/dbt/semantic/*` and `tabs/metrics/lib/*`

The M review's L-2/L-5/L-7 texts were lost, so I re-read those trees. All findings are low or medium
severity; none is a reason to hold the branch.

1. **MEDIUM — the SQL identifier gate lives one layer out from the boundary it guards.**
   `tabs/metrics/lib/explorer.ts:228` and `:263` write
   `date_trunc('${spec.granularity}', "${timeCol}")`, and `:158` writes
   `CAST("${col}" AS varchar) IN (…)`. None of them checks anything locally. The runtime allow-list
   that closed the `timeGrain` injection lives at the *dashboards* door (`PANEL_TIME_GRAINS`,
   `assertServableFilters`). ARCHITECTURE.md's own rule is "a string that reaches SQL as an IDENTIFIER
   or a KEYWORD must be checked against a closed runtime allow-list, **at the boundary where it
   enters**" and "a gate that lives in three call sites is a gate that is missing from the fourth".
   There is no un-gated caller today; the next one will be. This is the substance of M11's `false`.
2. **LOW — filter values are escaped, not bound.** `explorer.ts:157` is
   `'${v.replace(/'/g, "''")}'`. Quote-doubling is correct for Trino, and the governed executor
   additionally refuses `--` and `/* */` (which is what D's M-9 warning surfaces), so this is
   defence-in-depth rather than a hole — but the row claims parameterisation and the code does not do
   it.
3. **LOW — `SAFE_EXPR_RE` admits an expression with no identifier in it.**
   `semantic/validate.ts:48` is `/^[A-Za-z_][A-Za-z0-9_]*$|^[A-Za-z0-9_ ().,+\-*/]+$/`. The second
   branch accepts `+++`, `(((` or `.`, which would be emitted as a dbt `expr` and fail `dbt parse`
   **for the whole domain** rather than being refused per-measure — exactly the failure mode the module
   exists to prevent. One-character fix: add a `(?=.*[A-Za-z_])` lookahead.
4. **COSMETIC — the first alternative of `SAFE_EXPR_RE` is dead.** Every string the first branch
   matches is also matched by the second; the alternation can be deleted.
5. **LOW — `isSafeSemanticFilter` splits on `' AND '` unconditionally** (`validate.ts:65`), so a
   legitimate literal containing " AND " (`region = 'A AND B'`) is split mid-literal and the measure is
   refused by name. The refusal is honest and the rest of the dataset still lands, so nothing breaks —
   but that value can never be expressed. Same shape in `PREDICATE_RE` (`:37`), whose literal class
   `'[^'{}%#]*'` also excludes `#` and `%`, so `region = 'A#1'` or any percentage string is refused.
   Worth a line in `docs/components/dbt.md` stating which literals the closed grammar cannot carry.
6. **GOOD, worth keeping deliberately** — three things I went looking for and found already right:
   `validate.ts` is a key/enum **whitelist**, not a blacklist, so an unknown DSI key is a violation;
   `renameMetric` (`tabs/metrics/lib/lifecycle.ts:179`) freezes `measure.name` and moves only the
   label, so no consumer is orphaned, and it snapshots to the version log *before* the change;
   `from-measures.ts` refuses a measure by name rather than guessing, and the project README names the
   refusal, so one bad measure costs one measure.

## 6. Iteration-2 recommendation

### Tonight — one 2–3 hour round, in this order

Every item is a doc change, a mount, a test, or a guard. None touches a read or write path that serves
a number, so none can regress a live dashboard.

| # | Item | Flips | Effort | Files |
|---|---|---|---|---|
| 1 | Correct the four stale rows in `docs/components/git.md`'s layout table and add a tripwire that parses it and deep-equals `GIT_OBJECT_LAYOUT` | **G2** | 20 min | `docs/components/git.md`, `os-ui/core/infra/git-objects-kinds.test.ts` |
| 2 | Register the `dataset` and `lifecycle-pin` git-object resolvers at boot (then `metric`, which needs a governed read returning `{domain, semanticModel, ownerUid}`) | **G3 + G7** | 20 min for two kinds, 45 for all three | `os-ui/instrumentation.ts`, new `os-ui/tabs/data/lib/git-object.ts`, wire `os-ui/tabs/metrics/lib/git-object.ts`, extend `core/infra/git-objects.test.ts` |
| 3 | Delete the 27 Cube claims in `tabs/dashboards/**` and add `'tabs/dashboards'` to `honest-text.test.ts`'s `TREES` | **M13 + X9** | 30 min | the 9 files listed in the M13 row, `os-ui/tabs/metrics/lib/honest-text.test.ts` |
| 4 | Mount `<CloneRepository>` and `<GitHeadBadge>` on the Data, Metrics, Dashboards (+ Software, Agents for clone) detail headers | **E10 + G6** | 35 min, one pass | five tab `ui/` detail headers |
| 5 | Add the dataset-tier ceiling to `governMetric` and a test | **M12** | 25 min | `os-ui/tabs/metrics/lib/governance.ts`, `governance.test.ts` |
| 6 | Add the degradation-precedence co-occurrence test | **D12** | 15 min | `os-ui/tabs/dashboards/lib/build/panel-query.test.ts` |
| 7 | Free cleanups, no row attached: the `(?=.*[A-Za-z_])` lookahead on `SAFE_EXPR_RE`; delete its dead first alternative; wire or delete `coin-test.test.ts`'s placeholder `dataset` row (−2 todos); add the acting-admin assertion to the cross-domain move test (closes open item 8) | — | 25 min | `semantic/validate.ts`, `tabs/agents/lib/git/coin-test.test.ts`, `tabs/dashboards/lib/git/commit.test.ts` |

Items 1–6 take **false 46 → 39** and **true 98 → 105**, with the 122-row aimed-at set going from
98/17/7 to 105/10/7. Re-run all four gates after each item; nothing here should move a baseline.

### Morning — decisions, or longer than one round

1. **`sanitizeIdent` collision** (§4). Above every row on this list.
2. **M11 / the explorer SQL boundary** (§5 item 1). Move the allow-list into
   `previewTrinoSql`/`windowTrinoSql` and bind filter values. ~1.5 h, and it touches the metric read
   path, so it wants daylight and a careful gate run.
3. **M6** — rewrite the row to what the code guarantees, or refuse `cumulative`/`derived` and accept
   the dashboard regression. A decision, not a patch.
4. **M7** — decide whether the metric lifecycle overlay becomes a committed `os/` file (then
   archive/unarchive/move commit for free) or whether the row narrows to the four file-owning writes.
5. **M8** — extract `promoteMetricService` and give the Metrics promote path a parity suite (~45 min).
6. **V3** — call S4's `annotatedTag` from `goLive`; it landed tonight with no caller. ~30 min, but it
   is a new write on the operate path.
7. **E2/E1 contradiction** (open item 4) — lower the Access-tokens nav to `creator`, or state plainly
   that a creator cannot clone. One word, one posture decision.
8. **The 13 unheld platform MCP writes** (open item 1) — adding them moves the shipped Software
   Delivery Team's governance posture and the frozen engine goldens.
9. **X11 / the SBOM** (open item 3) — `--exclude './.claude/**'` on both syft lines, regenerated from a
   pristine clone.
10. **S8** — a route for app-declared actions into the agent tool catalogue.
11. **S9** — whether an ungranted dataset reference becomes a refusal at commit.
12. **`tab:assistant` → `tab:ask`** (open item 6) — a one-line rename that moves a cost series.
13. **S-9 residual** (open item 12) — null-origin frame + postMessage RPC. Architectural.
14. **`git-http:1.0.0`** (open item 10) — build and push, then E1, E8 and the Part C clone/push steps
    become measurable.
15. **Trino client authentication** (open item 5) — set `TRINO_AUTH_METHOD` on **os-ui** (never the
    worker) and trigger a regeneration, exactly as `docs/components/trino.md` now describes.

## 7. What I could not measure, and why

| Rows | Why | The exact step that would prove it |
|---|---|---|
| **M2** | No cluster; `dbt parse` never ran. The whitelist validator is green over every generated file. | On kind: `python /opt/dagster/app/os_projects.py --parse /repos-checkout/sales/current`, then grep `"resource_type": "metric"` in `target/manifest.json`. |
| **M10** | The two-viewers half is *simulated* — `gate.test.ts` "GATE 3" stubs the executor with a region filter rather than exercising Trino RLS. The outage half is genuinely green. | Two real users with different region claims open the same metric on the deployed build and compare rows. |
| **T9** | Real dbt is not installed anywhere in the tree; the tar round-trip and the OS's own offline parse gate are green over the real goldens. | `pip install "dbt-core>=1.9,<1.10" "dbt-trino>=1.9,<1.10"`, download `/api/data/projects/<domain>/export`, untar, `dbt parse`. |
| **E1** | `git-http:1.0.0` is not built or pushed, so there is no HTTPS endpoint to clone from. The auth decision and a real local clone through the real hooks are green. | Build and push the image, deploy the ingress, then `git clone https://<os>/git/sales.git` as a member. |
| **E8** | No Dagster to observe. The unit per-kind half — registry row, generated files, commit, `OS-Surface: git:push`, pusher as author — is green. | On kind: push a `models/**.sql` + `schema.yml` and confirm the Dagster asset appears through the existing reload hook. |
| **V8** | No browser. The whole machine-checkable half (MCP registry, four components, two badges, two toggle options, one button per state, one shared dialog, the seven tile mounts, the no-environment/stage/release string scan) is green. | Open the seven tile surfaces and the go-live dialog and read them. |
| **X12** | No deploy from a worktree; the night's guardrails forbid one. | `./scripts/deploy.sh <version>` run **directly, never through a pipe**, then Part C steps 1–11 in order. |

Also unmeasurable and worth stating plainly: **no `mcp` row was exercised against a live server** —
there is no deployed 0.9 build tonight. Where an `mcp` claim is scored `true` it is because a unit test
drives the MCP dispatcher **in-process with a signed-in principal**, which the brief permits: that is
how `S6` (`callPlatformMcp`), `X8` (`handleRpc`), `C7` (`tools/call` through the dispatcher), `T8`,
`G7` and `V7`/`V9` (registry-wide) were scored. Every other `mcp` half is folded into the
`untestable here` reasons above.
