# Definition of done: metrics, dashboards, chat, software, git, the engineering view, the engineer's door and lifecycle

> Companion to `2026-11-14-metrics-dashboards-chat-software.md`. This is the **acceptance checklist**
> the programme is tested against at the end of every iteration. Each item states **how it is
> tested**, so "done" is a measurement, not an opinion. An item that cannot be tested in the
> environment available is marked `untestable here` with the reason, never silently ticked.

**The standard:** a data, AI or platform engineer who knows dbt, Dagster, Trino, LangGraph, Langfuse,
LiteLLM, ECharts/Superset and git should be able to read what the OS produced and recognise their own
practice — and should be able to clone the repo and work from VS Code if they prefer. A business user
should be able to do the same things in a form, in Ask the OS or over the MCP and get the **same
files**. The OS adds governance, identity, lifecycle and ease **on top**; it does not reinvent how
the tools work, and it does not hide them.

Legend for the **Test** column: `unit` = automated test in the suite · `kind` = verified against the
local kind cluster · `stackit` = verified against production after deploy · `inspect` = read the
generated artefact or the source and confirm · `mcp` = exercised through the OS MCP as a client would.

**Status** at creation is `false` for every row — this checklist is written **before** the work, which
is the point. `false (…)` says what is missing · `true (test: …)` names the file that makes it true ·
`untestable here (…)` gives the exact step that would prove it. A row may be ticked only by the agent
that measured it, citing a test it has read.

---

## Part 1 — Metrics as dbt metrics (stream M)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| M1 | A metric defined in the OS is a dbt `metrics:` entry, with its `semantic_models:` measure, in a `.yml` file inside the owning domain's dbt project — not only an OS record. `models/semantic/<model>.yml` appears in the generated tree. | `unit` golden on `generateProject` (a new fixture beside the three in `tabs/data/lib/dbt/fixtures/`); `inspect` a checkout | M | false (not started) |
| M2 | The emitted semantic YAML is **spec-valid** against the pinned spec: `dbt parse` succeeds on the generated project with the semantic block present, and the manifest contains the metric node. | `unit` schema validation of the emitted YAML; `kind` `python /opt/dagster/app/os_projects.py --parse /repos-checkout/<domain>/current` then grep `metrics` in `target/manifest.json` | M | false (not started) |
| M3 | Emission round-trips: a hand-edited metric YAML parses back into the OS model and re-emits byte-identically; two regenerations of the same state are byte-identical. | `unit` `parse(emit(x)) === x` on one fixture per metric type + an idempotence golden | M | false (not started) |
| M4 | The emitter targets **one pinned spec version** (DSI 0.8.5 / dbt-core 1.10 field names) behind a single constant, the generated README says which, and the version the images actually carry has been read and recorded. | `unit` the constant and its test; `inspect` the image's dbt version, recorded in the stream report | M | false (not started) |
| M5 | `type: simple` and `type: ratio` are emitted correctly, ratios with a per-side `filter:`, and `count_distinct_approx` emits as `count_distinct` + `config.meta.os_agg` with the approximation honoured by the OS compiler. | `unit` per type | M | false (not started) |
| M6 | A metric type the OS compiler cannot serve is **refused with a typed, named refusal** rather than returning a number — tonight that is `cumulative` and `derived`. No wrong number, ever. | `unit` the refusal cases | M | false (not started) |
| M7 | Every metric write (define / edit / rename / archive / delete / promote) is a **git commit** in the domain repo authored as the acting user, with `OS-Action` / `OS-Object: metric:<id>` / `OS-Surface` / `OS-Request-Id`. | `unit` extend `tabs/data/lib/dbt/commit.test.ts`'s mutator enumeration with the metric writers × flag on/off; `kind` `git log --stat` | M | false (not started) |
| M8 | The MCP and the UI produce the **same** commit and the same project files for the same metric change, differing only in the `via mcp:<tool>` / `via ui:<route>` subject half. | `unit` extend `tabs/data/lib/mcp-parity.test.ts` to `define_metric` / `promote_metric`; `mcp` drive define → query | M | false (not started) |
| M9 | A **time-spine** model exists in every generated project whose domain declares a time dimension, declared with the dbt 1.9+ `time_spine` property, and the materialisation choice and span ownership are recorded. | `unit` generator golden; `inspect` the recorded decision; `kind` the spine asset materialises | M | false (not started) |
| M10 | Every metric read runs as the signed-in user: two viewers of the same metric and slice get different rows; a Trino outage yields **no number** and an honest message. | `unit` the existing `explore-server` honesty-gate shapes; `stackit` two real users on one dashboard | M | false (not started) |
| M11 | A requested member the model does not expose is **reported**, never silently dropped; query-time identifiers pass `assertColumn` and filter values are parameterised. | `unit` the dropped-member cases + an injection suite | M | false (not started) |
| M12 | A metric's tier follows the data ladder with the existing role and consistency gates; promotion moves its YAML lane in one commit; a metric may not be promoted above its dataset. | `unit` `governance.test.ts` + a lane-move golden; `mcp` creator files, domain_admin approves | M | false (not started) |
| M13 | No agent- or user-facing text claims Cube serves or secures a number: `define_metric`, `query_metric`, `tabs/metrics/context.md` and the UI strings are corrected; `list_metrics` returns the metric type and grain. | `inspect` + `unit` grep tripwire under `tabs/metrics`, `tabs/dashboards`, `core/mcp` | M | false (not started) |
| M14 | **`metricflow` resolves to ≥ 0.209.0 wherever it is installed** (≤ 0.208.1 is BSL, whose Additional Use Grant excludes this product), asserted by the licence gate. | `unit` a version-floor assertion in `scripts/license-check.sh` / the licence gate; `inspect` the Dagster image requirements | M | false (not started) |
| M15 | `[later]` The OS compiler's numbers **agree with MetricFlow's** for the same committed YAML on the same data, with `count_distinct_approx` excluded for a stated reason. | `unit`/CI differential harness: `pip install "dbt-metricflow[dbt-duckdb]"`, `mf query` per metric × grain × slice | M (backlog) | false (backlog) |
| M16 | `[later]` `saved_queries` → `exports` are declared in the project and materialise as a Dagster asset as the declared principal; the OS reads their freshness from Dagster. **The executable form is a generated dbt model** — there is no `mf export` command and `dbt sl export` is Cloud-only. | `unit` generator golden + a `parse_saved_queries` in `os_projects.py`; `kind` the asset materialises | M (backlog) | false (backlog) |

## Part 2 — Superset-class dashboards (stream D)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| D1 | Exactly **one** chart rendering surface: `core/ui/charts/` owns the ECharts registration, the theme bridge and the formatters; `tabs/dashboards`, `tabs/data` and `tabs/software/appspec` import it and register nothing of their own. | `inspect` grep `from 'echarts` outside `core/ui/charts/` returns nothing (as a `unit` tripwire); `unit` the same spec renders identically in two hosts | D | false (not started) |
| D2 | Every file in `os-ui/vendor/superset/` retains its **ASF header verbatim** and carries `Modified from apache/superset <path> @ <sha>` plus the list of changes. | `unit` a header ratchet over the vendored tree; `inspect` | D | false (not started) |
| D3 | `os-ui/vendor/**` is **excluded** from the `FEATURE:`/`USER STORY:`/`ARCHITECTURE:` ratchet (ASF policy forbids rewriting third-party headers) and **included** in the licence-header ratchet instead — landed in the same change as the first vendored file. | `unit` both ratchets; `inspect` `scripts/check-structure.mjs` | D | false (not started) |
| D4 | `licenses/components.tsv`, `THIRD-PARTY-LICENSES.md`, `core/kernel/licenses.ts` and `sbom.cdx.json` name the vendored Superset source **pinned to a sha, not a version**, and `core/kernel/licenses.ts` carries the **ECharts** row it lacks today. `scripts/license-check.sh` is green with **no new SPDX id**. | `inspect`; `scripts/license-check.sh` | D | false (not started) |
| D5 | No vendored dependency moves the OS off React 19 / Next 15; exactly one React copy. | `inspect` the lockfile diff; `npm ls react` | D | false (not started) |
| D6 | Nothing is branded "Superset" — not a route, not a package name, not a logo; the permitted form is "includes code derived from Apache Superset". | `inspect` | D | false (not started) |
| D7 | One vendored ECharts transformer renders a real panel behind `core/ui/charts/`, with its pure transform under test. | `unit` the transformer against a fixture; `inspect` the rendered panel | D | false (not started) |
| D8 | Every save of a dashboard — UI or MCP — is a **git commit** under `dashboards/<slug>/dashboard.yaml` in the owning domain's repo, authored as the acting user, naming the action and the surface. | `unit` on the commit builder; `kind` two saves → two commits with the right author | D | false (not started) |
| D9 | The committed `dashboard.yaml` is human-readable and round-trips: generate → read → generate is byte-stable, and a hand-edited file imports; references are `metric:<id>` / `dataset:<id>` ids, never embedded queries; a missing id **fails loudly** on import. | `unit` goldens + round-trip + the missing-id refusal | D | false (not started) |
| D10 | A filter operator the governed path cannot serve is a typed `bad_request`, never a silent under-filter. | `unit` `operator: '>='` → typed error | D | false (not started) |
| D11 | `create_dashboard`'s `vizType` enum equals the `VizType` union, with a drift tripwire. | `unit` enum-equality tripwire | D | false (not started) |
| D12 | The loud-degradation precedence — outage > unresolved member > dropped slice dimension — remains the warning authority, and every new path routes through it. | `unit` one case per new path | D | false (not started) |
| D13 | A panel accepts **no ad-hoc SQL**; the only bridge from exploration is promoting a query to a metric. | `inspect` + `unit` | D | false (not started) |
| D14 | `[later]` A real layout: a persisted tree of tabs → rows → panels with x/y/w/h, drag and resize; an absent layout falls back to today's flow order. | `unit` layout → deterministic render order; `unit` back-compat | D (backlog) | false (backlog) |
| D15 | `[later]` A native filter bar — value, numeric-range, date-range, time-grain — with scope and defaults, every filter landing in the governed WHERE; a non-member filter dropped **loudly**. | `unit` per filter type + scoping | D (backlog) | false (backlog) |
| D16 | `[later]` A pivot table with row and column groupings and subtotals, computed in SQL or a declared, tested post-processing step — never in the browser over partial rows. | `unit` the compiled SQL for a 2×2 pivot | D (backlog) | false (backlog) |
| D17 | `[later]` MCP parity: `update_dashboard`, `add_chart`, `remove_chart`, `render_dashboard_data`, the last returning every panel's governed rows **as the caller** with the UI's warnings. | `mcp` build and read a dashboard through MCP only; `unit` unseeable id → `not_found` | D (backlog) | false (backlog) |
| D18 | `[later]` Any result cache is keyed by principal **and** resolved Trino groups **and** the full panel slice, with a tripwire that a principal-less key cannot be constructed. | `unit` key composition; `unit` A's hit is B's miss | D (backlog) | false (backlog) |
| D19 | `[later]` A scheduled snapshot is rendered **per recipient** under that recipient's identity; a recipient who lost entitlement gets nothing, never stale rows. | `unit` per-recipient rows + the revoked case; `kind` the bell | D (backlog) | false (backlog) |
| D20 | `[later]` `mapbox-gl` is on `licenses/denied-licenses.txt` (proprietary since v2.0; a TOS is not an SPDX id) and `maplibre-gl` is the only permitted map renderer. | `inspect`; `scripts/license-check.sh` | D (backlog) | false (backlog) |
| D21 | `[later]` The Superset Helm chart and its bundled-app `components.tsv` row are removed **in one change**, when this stream completes — not before, or the OS ships no dashboard product. | `inspect`; `helm template` renders no Superset | D (backlog) | false (backlog) |

## Part 3 — Chat to the data (stream C)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| C1 | A conversation turn is **one** Langfuse trace with its tool calls nested — `observe: { traceId }` reaches `liteLlmCaller` from the assistant path. Today each model call is its own orphan trace. | `unit` the real SDK with a recording transport (the `engine/observe.test.ts` pattern); `stackit` fetch `/api/public/traces/<threadId>` | C | false (not started) |
| C2 | `OS_RULES` states the semantic-layer-first rule: for any question about a number, `list_metrics` → `query_metric`; `query_data` only when no metric member exists, and then always show the SQL and the row bound. | `unit` an `OS_RULES` content tripwire | C | false (not started) |
| C3 | The same rule is in `core/guides/overview.guide.md`, `tabs/metrics/guide.md`, `tabs/dashboards/guide.md` and `tabs/data/guide.md`, so an external MCP client gets it too. | `inspect` + `unit` tripwire | C | false (not started) |
| C4 | `DISCOVERY_COMPANIONS` carries `query_metric: ['list_metrics','get_metric','get_dataset']` and `create_dashboard: ['list_dashboards','list_metrics','get_dataset']` — widening discovery, never authority. | `unit` | C | false (not started) |
| C5 | When a result was clipped, the turn shows `rowLimit` and the query-tool's own `message` **verbatim**, and a guard test fails if the truncation fields are dropped anywhere on the chat path. `OS_RULES` forbids aggregating a truncated result. | `unit` the guard test + the rule tripwire | C | false (not started) |
| C6 | An ad-hoc `query_data` answer is visibly labelled ad-hoc and unverified. | `unit` + `inspect` | C | false (not started) |
| C7 | `query_metric`, `query_data`, `preview_metric`, `suggest_metrics`, `get_metric` and `get_dashboard` declare an MCP `outputSchema` and return the artifact payload as `structuredContent`. | `unit` schema validity of each payload | C | false (not started) |
| C8 | One shared artifact type module exists — `table` · `chart` · `metric_draft` · `dashboard_draft` · `citation` · `clarification` — generalising the existing `StageSuggestions` family rather than paralleling it. | `unit` round-trip per kind; `inspect` | C | false (not started) |
| C9 | `/api/assistant/chat` returns `artifacts[]` beside `content` and `tools`, and the drawer renders `table` and `citation` by extending the existing tool-chip mechanism. | `unit` on the route's service module; `inspect` the drawer | C | false (not started) |
| C10 | **No** `dangerouslySetInnerHTML`, `eval` or `new Function` anywhere on the chat or artifact path; no model-authored HTML, SVG or JS is rendered; no number in an artifact comes from the model's arithmetic. | `unit` a path-scoped guard test | C | false (not started) |
| C11 | `[later]` A `chart` artifact is a `Panel` → `/api/dashboards/panel-query` → the existing `PanelChart.tsx`, so two viewers with different RLS see different bars from the identical turn. | `unit` two principals, one turn | C (backlog) | false (backlog) |
| C12 | `[later]` The built-in `os.analyst` system ships in the repo, is not user-editable, is compile-verified, and read-only is enforced by the node's **tool allowlist**: a prompt-injected instruction inside a data value produces **zero** write calls. | `unit` the compile-verify path + a red-team fixture | C (backlog) | false (backlog) |
| C13 | `[later]` The engine migration from `runAgentic` to `runOsTeam` ships behind a flag with the old path intact and a parity harness; read-only intents first. | `unit` the parity harness | C (backlog) | false (backlog) |
| C14 | `[later]` Threads are durable: thread id = run id = Langfuse trace id in `agent_runs`, keyed `{userId, threadId}`, with a guard test that a second user in the same domain cannot read or resume one; a `memory` checkpointer is visibly labelled; the client-authoritative `.slice(-20)` is deleted. | `unit` the per-user guard; `kind` survives a pod restart | C (backlog) | false (backlog) |
| C15 | `[later]` The write path: draft → preview → **explicit confirm** → the same MCP tool the UI uses → the commit path; the writer node's allowlist is only `define_metric` and `create_dashboard`; a write never fires from tool output alone. | `unit` per step | C (backlog) | false (backlog) |
| C16 | `[later]` `add_panel_to_dashboard({dashboardId, panel})` closes the lost-update race; `ask_os({question, threadId?, artifacts?})` returns the **same** payloads as the UI; no `create_dashboard_from_chat` tool exists. | `unit` a payload-parity golden; `inspect` the tool list | C (backlog) | false (backlog) |

## Part 4 — Software, hosted properly (stream S)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| S1 | **No shipped file claims a component that does not exist**: the scaffold README/Dockerfile, `tabs/software/lib/README.md`, the `config.ts` Forgejo/Harbor/Kaniko blocks and the dead `kanikoImage` / `softwareBuildEnabled` / `softwareBuildNamespace`, `forgejoConsoleUrl`, the dangling `values.yaml` comment, and the Admin "Argo CD reverts drift automatically" over mock data. | `unit` a tripwire grep over the shipped tree; `inspect` | S | false (not started) |
| S2 | The `serveMode` default is `'spec'`, and a missing image **fails closed and loudly** — no app can serve `traefik/whoami` on a customer domain. | `unit` the default + the fail-closed case; `stackit` no app serves whoami | S | false (not started) |
| S3 | A `demo-seed` result is **structurally unusable** in any gate, review card or `verify_software` verdict. | `unit` | S | false (not started) |
| S4 | `core/infra/git-store.ts` gains, **additively**, `annotatedTag`, `listTags(prefix)`, `resolveTag` and a path-scoped `log`, changing no existing export's signature. | `unit` against a real bare repo in a temp dir | S | false (not started) |
| S5 | An app's source tree lives in the domain repo under `apps/<slug>/` via `commitSubtree` + `reserveSubtree('apps/')`; the OpenSearch mirror is a cache of the committed tree; the compile gate still runs **before** any write and a red gate commits nothing (422 with diagnostics). | `unit` the commit path + the pre-write gate; `kind` `git log` | S | false (not started) |
| S6 | `push_app_files(appId, files[], message)` is the one documented verb for "code in Claude, deploy to the OS": it returns `{commit, changed, gate}` and a preview URL, and pushing identical files twice yields **one** commit with the pusher as author. | `unit` + `mcp`; `kind` `git log` | S | false (not started) |
| S7 | **App → agent**: the SDK's `os.agents.run/get/decide` call the same run door as the UI and the MCP, as the signed-in user over the same-origin session, never a service principal and never the app's key; a held write surfaces as the typed `parked` state with its approval id. | `unit` with fakes; `kind` the triangle step 1 | S | false (not started) |
| S8 | **Agent → app**: an app declares actions that register as governed tools through the existing `list_adoptable_actions` / `adopt_entity_actions` path (audited, with what changed stated), executed as the **run's** principal within the app's declared scopes, held under the read-only preset when they write, and visible as tool spans in the run trace. | `unit` the adoption intersection + the hold; `kind` the triangle step 2 | S | false (not started) |
| S9 | **App ↔ data and agent ↔ data** go only through governed paths (bounded `query_data`, `os.records`, the data services), always as the end user; RLS, OPA and the lifecycle rules hold; **no app-level credential can widen access**; an ungranted dataset reference is refused and flagged on commit and on the review card. | `unit` two sessions → different rows; `unit` the ungranted refusal | S | false (not started) |
| S10 | **The triangle**: an app calls an agent → the agent writes a dataset row through a governed tool → the app reads it back, with all three steps attributed to the **same user** in `run_events`, the Langfuse trace and the git commit. Negative: a tool outside the app's scopes is refused per the tab's convention; a writing app action is held. | `unit` end-to-end with fakes; `kind`/`stackit` the live triangle (Part C step 5) | S | false (not started) |
| S11 | `[later]` `release_software` writes `apps/<slug>/.app/release.json` and creates the annotated tag `app/<slug>/v<x.y.z>`; a failing blocking gate creates **no tag**; a tag is immutable (409 on re-release); `list_releases` returns tags newest-first with gate results and approval state. | `unit` + `mcp` | S (backlog) | false (backlog) |
| S12 | `[later]` The review card and the approval record the **release tag and commit**, plus the test result, SBOM, vulnerability report and artefact digest — the six fields an IT department asks for. | `unit` + `inspect` a card | S (backlog) | false (backlog) |
| S13 | `[later]` The gate set runs in order and blocks: compile → tests → secret scan → SAST (a real engine, not the regex) → dependency vulns (fail high/critical against the committed lockfile) → licence policy → SBOM (CycloneDX 1.7; its absence blocks the tag). `npm audit` is not "the" dependency gate. | `unit` per gate; `inspect` the tool and its licence | S (backlog) | false (backlog) |
| S14 | `[later]` Every gate result is one `PipelineRun` with `get_pipeline_status` and a bounded `get_pipeline_log`; an unreachable backend returns an honest degraded status, **never a fabricated pass**. | `unit` + `mcp` | S (backlog) | false (backlog) |
| S15 | `[later]` Promotion **re-points and never rebuilds** (a test asserts the artefact hash is byte-identical across environments); `rollback_software` re-pins without rebuild or re-review, audited, and refuses a never-approved release (403). | `unit` the hash equality + the rollback cases | S (backlog) | false (backlog) |
| S16 | `[later]` Tier 2's bundle is content-addressed: hashed, stored, pinned and served by hash — not re-bundled per request. | `unit` | S (backlog) | false (backlog) |
| S17 | `[later]` Per-domain quotas enforced at `decide_deploy`; `agentic-apps` PSS moved from `baseline` to `restricted` with the runner still admitting; Tier 3 only behind an operator flag, with kpack/CNB preferred and Kaniko never revived. | `unit` quotas; `kind` the PSS move | S (backlog) | false (backlog) |

## Part 5 — Git everywhere, and git made visible (stream G)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| G1 | **No builder artefact kind exists whose writer does not commit.** One enumeration test over all kinds; a kind that is deliberately backlog is listed as backlog **in the test**. | `unit` the all-kinds enumeration | G | false (not started) |
| G2 | The repo layout table in `docs/components/git.md` is true for every kind listed, personal lanes included. | `inspect` a checkout per kind | G | false (not started) |
| G3 | `objectGitInfo(kind, id)` returns `{head, history[], truncated}` for every kind, resolving by the `OS-Object` trailer **with a path-based `git log -- <path>` fallback**, so **`git.head` is never null for an object that has files in the tree** — including objects whose only commits are platform boot-reconciles. | `unit` against a real bare repo incl. the boot-reconcile-attributed case; `kind` open a pre-existing object's badge | G | false (not started) |
| G4 | `getVersion(kind, id, sha)` returns the object's files at that commit and `diffVersions(kind, id, a, b)` returns a unified diff. | `unit` | G | false (not started) |
| G5 | All three reads are owner/scope gated: an object the caller cannot see returns a **byte-identical `not_found`** to one that does not exist. | `unit` per kind | G | false (not started) |
| G6 | `core/ui/git/` provides `GitHeadBadge` and `HistoryDrawer` with the logic in testable `.ts`; the five detail headers mount the badge and nothing more; the Agents header line is unified onto the shared component rather than kept as a second implementation. | `unit` on the `.ts`; `inspect` the five mounts | G | false (not started) |
| G7 | `get_history`, `get_version` and `diff_versions` take `{kind, id}`, work for every kind, and reach the **same module** the drawer uses. | `unit` UI/MCP parity per read; `mcp` | G | false (not started) |
| G8 | Every boot-time or reconcile-time writer calls `hydrationState()` first and does nothing unless it is `'hydrated'`; `DestructiveReconcileError` is not weakened. | `unit` per new reconcile; `inspect` | G | false (not started) |
| G9 | `[later]` `restoreVersion(kind, id, sha)` re-applies a version **through the object's normal writer**, producing one new commit — never a history rewrite — with every normal gate and approval still applying, and owner/scope gated. | `unit` per kind incl. the refusals | G (backlog) | false (backlog) |
| G10 | `[later]` Governance → **Repositories** lists each domain repo with head, commit count, last author, mirror status from the `git-mirror` health row and an "open in mirror" link; `ReleaseList` shows an app's tags. | `inspect`; `kind` | G (backlog) | false (backlog) |

## Part 6 — The engineering view (stream T)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| T1 | Every object kind touched by this programme or last night's has an `EngineeringView` from a **pure, testable, MCP-serialisable** adapter in that tab's `lib/engineering.ts`, registered in `core/engineering/`. | `unit` one adapter test per kind | T | false (not started) |
| T2 | **No label on an engineering panel uses an OS-only noun** without the tool's noun: "dbt model", "dbt metric", "Dagster asset", "Dagster schedule", "LangGraph node", "Langfuse trace", "Trino query", "LiteLLM key alias", with the OS term in parentheses at most once. | `unit` a data-driven vocabulary test over the allowed noun list | T | false (not started) |
| T3 | The **dbt** section shows the model SQL and the `schema.yml` / `sources.yml` / `semantic_models` / `metrics` YAML **as stored in the repo**, the repo path, and `dbt build --select <node>` / `dbt test` / `mf query --metrics …`. | `unit` against a fixture; `inspect` against a checkout | T | false (not started) |
| T4 | The **Dagster** section shows asset keys, job and schedule names, the last run id and status, an "Open in Dagster" link through the tool proxy, and `dagster asset materialize --select …`. | `unit`; `kind` the link resolves and the run id matches the Dagster UI | T | false (not started) |
| T5 | The **LangGraph** section shows the compiled graph as JSON — plan/act/tools/route nodes, edges, `when` guards, state channels, interrupt points — plus the checkpointer, thread-id = run-id and the resume semantics. | `unit` against a compiled fixture | T | false (not started) |
| T6 | The **Git** section shows the file list with paths and the head sha, **composing** G's badge rather than duplicating it; the **Langfuse** section shows the trace URL and states what is redacted and why. | `unit`; `inspect` | T | false (not started) |
| T7 | A section the adapter cannot fill, and a deep link that cannot resolve, say **why** — never fail silently. | `unit` the unresolvable cases | T | false (not started) |
| T8 | `get_engineering_view({kind, id})` returns the identical structure the panel renders. | `unit` parity; `mcp` | T | false (not started) |
| T9 | The domain dbt project downloads as a tarball and **`dbt parse` accepts it** outside the OS; the commands to run it are documented. | `unit` through the existing parse gate; `kind` run `dbt parse` on the downloaded tarball | T | false (not started) |
| T10 | `[later]` The **Trino** section shows the compiled SQL, catalog and schema, who it runs as, and a "preview as me" button bounded by the existing query budget; the **LiteLLM** section shows routes, the key **alias** (never the key), the tags and the budget. | `unit`; `kind` | T (backlog) | false (backlog) |
| T11 | `[later]` An agent system exports as `system.yaml` + the compiled graph JSON; a dashboard as its dashboard-as-code file; an app as its tree + `release.json` — each with the command to run it elsewhere; and every `list_capabilities` description names the tool it maps to. | `inspect`; `unit` | T (backlog) | false (backlog) |

## Part 7 — The engineer's door (stream E)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| E1 | **Read is unconditional.** Anyone with access to a domain can `git clone https://<os>/git/<domain>.git` and read the **whole** tree, `os/*.yml` governance metadata included. | `unit` the fake-receive read path; `kind` a real clone | E | false (not started) |
| E2 | A personal access token is created in Platform → Access tokens, **hashed at rest**, shown **once**, listed by prefix and metadata only, revocable, and maps to exactly one OS identity. It never appears in a log or an error. | `unit` per property + a no-leak assertion | E | false (not started) |
| E3 | A push with a valid token lands and the registry updates from the pushed files; a push with no / expired / revoked token is a **401**. | `unit` the fake receive; `kind` a real push | E | false (not started) |
| E4 | A push to a path the pusher does not own is **rejected with a readable reason naming the file**; `os/*`, grants and anything secret-shaped are rejected with *"managed by the OS; change it in Governance or over the MCP"*. | `unit` per case | E | false (not started) |
| E5 | A push containing an invalid dbt project or an unparseable `system.yaml` is **rejected by the same validator the UI and the MCP call** — one endpoint, not a second copy. | `unit`; `inspect` that there is one validator | E | false (not started) |
| E6 | A non-fast-forward push to `main` is **refused**: the OS never rewrites, and never accepts a rewrite of, history. | `unit`; `kind` `push --force` is refused | E | false (not started) |
| E7 | An OS commit and an engineer's push cannot interleave: the pre-receive hook holds the **same per-domain git-store lock** for the duration of `receive-pack`; a lock wait is bounded and fails the push with a readable message rather than hanging the terminal. | `unit` the interleave test; `unit` the timeout path | E | false (not started) |
| E8 | `reconcileFromGit(domain, from, to)` updates the registry **from the files**, through the governed services (never a store directly), attributed to the **pusher** with `OS-Surface: git:push`, and reuses the existing Dagster reload and Trino-rules hooks. | `unit` per kind; `kind` a pushed model becomes a Dagster asset | E | false (not started) |
| E9 | Tonight's ingest covers dbt models + `schema.yml` → dataset records (name, layer, schema, columns, description, quality rules from the tests) and `agents/<slug>/system.yaml` → agent systems, each kind behind `ingestFromRepo(kind, files)`. | `unit` per kind | E | false (not started) |
| E10 | Every detail page shows the `git clone` command for the owning domain's repo, and the engineering panel links each artefact to its file in the repo. | `inspect`; `unit` on the `.ts` that builds the command | E | false (not started) |
| E11 | `docs/components/git.md` has a "Work from VS Code" section: clone, token, push, what is validated, what the OS does afterwards, and what is read-only and why; `os-ui/ARCHITECTURE.md` states the coin principle. | `inspect` | E | false (not started) |
| E12 | `[later]` Branches as proposals (`proposal/*` surfacing as a promotion request), PR-like review in the UI, the reverse mapping for the remaining kinds, apps by push, VS Code task snippets. | `unit`; `kind` | E (backlog) | false (backlog) |

## Part 8 — Lifecycle: Studio → Test → Run (stream V)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| V1 | `core/kernel/lifecycle.ts` is pure and **total over every kind**, returning `{draft, testing?, live?}`. | `unit` over all kinds | V | true (test: os-ui/core/kernel/object-lifecycle.test.ts — "lifecycleOf is TOTAL over every kind" + the junk cases; the module is os-ui/core/kernel/object-lifecycle.ts, re-exported from @core/kernel/lifecycle — deviation V-1) |
| V2 | **Lifecycle and audience are independent.** A `My` object can be Live; a `Company` object can have a Draft; neither axis is derived from the other and the promotion path is untouched. | `unit` both combinations + a tripwire that nothing derives one from the other | V | true (test: object-lifecycle.test.ts — all 3×3 audience×lifecycle combinations reachable, plus the source-reading tripwire that no function derives one axis from the other; the promotion tools are untouched) |
| V3 | `go_live(kind, id, sha?)` pins a commit or tag — git tag `live/<kind>/<id>`, or the SemVer release tag for apps — and records it in the OS-owned `os/lifecycle.yml`; `retire(kind, id)` unpins and deletes nothing. | `unit` both verbs; `inspect` the tag and the file | V | partly true (test: core/kernel/go-live.test.ts — both verbs against a REAL bare repo, the pin file's bytes asserted, retire deletes nothing). The file is os/lifecycle/pins.yml in its own reserved subtree, NOT a flat os/lifecycle.yml (deviation V-2), and NO git tag is written (deviation V-3: tag.written is false, honestly) |
| V4 | **Editing a live object does not change what Run shows until `go_live`.** Edit a live dashboard, assert the Run view is byte-identical, `go_live`, assert it changed. | `unit` the three-step case | V | true (test: tabs/dashboards/lib/lifecycle-adapter.test.ts — "editing a live dashboard does NOT change what Run shows until go_live": byte-identical spec AND the same ref after the edit, changed after go_live) |
| V5 | What **operates** reads the pin: an agent schedule runs the pinned definition and the Run view renders the pinned dashboard spec. | `unit` per kind | V | partly true (test: tabs/dashboards/lib/lifecycle-adapter.test.ts for the Run view; tabs/agents/lib/lifecycle-adapter.test.ts for the schedule, incl. fail-closed on an unreadable pin and the one-time fail-OPEN before the migration). TWO kinds HONOUR the pin, per the MVP cut line; ALL SEVEN can now hold one (review H-1). docs/components/lifecycle.md has the per-kind table |
| V6 | The **go-live guard**, one implementation, refuses when a dependency is not **live**, naming the offending dependency — dashboard → metrics and datasets; metric → dataset; agent system → granted resources; app → what it binds. It is about lifecycle, not audience. | `unit` per kind | V | true (test: object-lifecycle.test.ts "the guard refuses per kind, NAMING the offending dependency" for all five kinds + "the guard is about LIFECYCLE, not audience"; and end to end in tabs/dashboards/lib/lifecycle-adapter.test.ts against the real store) |
| V7 | There is **no other way** to change a lifecycle: no direct setter, no MCP field, no UI shortcut. | `inspect`; `unit` a tripwire | V | true (test: core/mcp/lifecycle-filter.test.ts — no set_lifecycle/promote_lifecycle/start_test/run_tests in the registry, and no tool but go_live/retire takes a lifecycle argument that is not the optional read filter; core/kernel/go-live.ts is the only writer) |
| V8 | **The simplicity contract holds**: three lifecycle words (Draft · Testing · Live) and three audience words, identical across kinds; one Studio\|Run toggle; two small badges; one Go-live button with one confirm naming what starts running; **exactly two** new MCP tools (`go_live`, `retire`); `lifecycle` **optional** on list tools with a default that preserves today; **no new required argument anywhere**; no UI copy says "environment", "stage" or "release" (except "release" for apps). | `unit` a vocabulary test + a required-argument tripwire over the registry; `inspect` the screens | V | partly true (tests: core/mcp/lifecycle-filter.test.ts for the MCP half — lifecycle never required, no list tool requires an argument, exactly two new tools; core/ui/lifecycle/badges.test.ts + lifecycle-cache.test.ts for the screen half — four components, two badges, two toggle options, one button per state, one shared dialog, no environment/stage/release in any UI string, and the seven tile mounts asserted). NOT verified: `inspect the screens` — no browser run. Software and Knowledge tiles show the filter but no lifecycle badge, to avoid a second "Draft" word (deviation V-12) |
| V9 | Every `list_*`/`get_*` result carries `lifecycle` and `audience`, and every `list_*` tool accepts the optional `lifecycle` filter — via **one** central helper, asserted by the registry-wide conformance test. | `unit` the conformance extension | V | true (test: core/mcp/lifecycle-filter.test.ts — every list_* tool either takes the identical shared property or is a documented exception, asserted in BOTH directions; lifecycle+audience on every row in both payload shapes; the registry-wide conformance test is still green, so no error shape changed) |
| V10 | **Nothing changes on day one**: the migration marks every existing object **Live**, so the Run view is today's screens; a newly created object is **Draft** and absent from Run until someone goes live. | `unit` the migration over existing fixtures + the new-object case per kind | V | true (test: object-lifecycle.test.ts — the migration marks all seven kinds Live and leaves them visible in Run, a new object is Draft and absent from Run per kind, and the migration is idempotent; core/kernel/go-live.test.ts applies it through the real pin store and repo) |
| V11 | Every LiteLLM call carries `env:studio|test|run` with per-lifecycle budgets in the key metadata, and the Langfuse trace's `environment` field is the lifecycle. | `unit` on the outgoing request body and the trace payload | V | true (test: core/infra/lifecycle-env.test.ts on the outgoing credential tags and the captured Langfuse trace payload; tabs/agents/lib/lifecycle-adapter.test.ts asserts a SCHEDULED run declares env:run, which rides the persisted run-queue record). The Studio run route and the verify paths take the `studio` default rather than passing it explicitly |
| V12 | `os/lifecycle.yml` is committed so an engineer's clone can read exactly what is live, and the receive gate rejects a push that changes it. | `unit` the rejection; `inspect` a checkout | V | partly true (the pin file is committed, readable in a clone AND read back: core/infra/lifecycle-pins.test.ts round-trips the YAML, hydrates the whole index from the committed bytes with the mirror dead, and proves every WRITE refuses with 503 unless a source answered). The push REJECTION is stream E's: core/infra/git-receive.ts does not exist in this branch |
| V13 | `docs/components/lifecycle.md` carries the per-kind Studio / Test / Run mapping table, how to try something out versus go live, and an explicit **physically versus logically separated** section. | `inspect` | V | true (docs/components/lifecycle.md — the per-kind Studio/Test/Run mapping table with [later] marked per kind, try-it-out versus go-live, the physically-versus-logically section, and a Deviations section) |
| V14 | `[later]` A draft dataset or metric builds into the author's lane or a `__dev` schema and a live one into the real schema; Dagster generates schedules only for live pins; Software preview/staging/prod map onto the lifecycle. | `unit`; `kind` | V (backlog) | false (backlog) |

## Part 9 — Cross-cutting (stream X)

| # | Must be true | Test | Owner phase | Status |
|---|---|---|---|---|
| X1 | Boot-reconcile commits carry per-object attribution, or the history lookup falls back to the path, so **`git.head` resolves for objects that existed before the reconcile**. | `unit` the pre-existing-object case; `kind` open such an object's badge | X (with G) | false (not started) |
| X2 | The agents reconcile skips a **zero-agent system**, not its whole domain. | `unit` | X | false (not started) |
| X3 | A successful tool no longer produces a tool span with `status: error`. | `unit` on the observer | X | false (not started) |
| X4 | Trace read-back no longer reports `owner: unknown`. | `unit` on the read-back adapter | X | false (not started) |
| X5 | `docs/components/trino.md` states the password and regeneration behaviour correctly. | `inspect` | X | false (not started) |
| X6 | `core/kernel/licenses.ts` carries the missing **ECharts** and **Superset** rows. | `inspect`; `unit` the licence list test | X (verifies; D lands) | false (not started) |
| X7 | The MCP `vizType` enum matches the model's `VizType` union. | `unit` the enum tripwire | X (verifies; D lands) | false (not started) |
| X8 | **The coin test.** For each object kind, the same change made (a) through its MCP tool and (b) by a `git push` produces **byte-identical files**, **identical registry state**, and an **identical history entry except `OS-Surface`** (`mcp:<tool>` vs `git:push`). Kinds tonight: the dataset model and the agent system. | `unit` one table-driven test; `kind` the live comparison (Part C step 8) | X (with E) | false (not started) |
| X9 | No agent-facing text claims "Cube secures the number", anywhere in the tree. | `unit` a grep tripwire | X (with M) | false (not started) |
| X10 | The structure ratchet, the regression gate and the full suite are green on the **merged** tree, and the ratchet baseline is no higher than at the start of the programme. | `unit`: `npm --prefix os-ui test`, `node scripts/check-structure.mjs`, `bash os-ui/scripts/gate.sh` | X (coordinator) | false (not started) |
| X11 | Every licence obligation this programme creates is discharged: vendored headers, `components.tsv`, `THIRD-PARTY-LICENSES.md`, `core/kernel/licenses.ts`, `licenses/notices/**`, the regenerated SBOM, and a green `scripts/license-check.sh` with **no new SPDX id** and **no AGPL or source-available code anywhere**. | `inspect`; `scripts/license-check.sh` | X (coordinator) | false (not started) |
| X12 | The deployed version on STACKIT passes Part C steps 1–11. | `stackit` | X (coordinator) | false (not started) |

---

## Iteration protocol

1. **Test.** At the end of a full pass over the nine streams, a **read-only** agent evaluates every
   item above against the merged tree and, where available, kind and STACKIT. It **reads every cited
   test rather than trusting it**. It produces a **gap report**: for each failing or
   `untestable here` item, the evidence and the smallest change that would make it pass.
2. **Plan.** The gaps are grouped into a new iteration appended to
   `2026-11-14-metrics-dashboards-chat-software.md` as "Iteration N", with phases, gates and the
   items they close.
3. **Design and implement.** Agents execute the iteration: implementation agents in parallel **only
   on disjoint areas**, each in its own worktree, merged by the coordinator in the stated order;
   reviewer and test agents read-only and freely parallel. Docs in the same commit.
4. **Repeat** until no item fails for a reason the environment permits fixing, or until two
   consecutive iterations close no further item. Untestable-here items are listed in the final report
   with exactly what would be needed to test them.
5. **Deploy** after each iteration whose gates are green, following Part C in order.

## Gap reports

(Appended by the test agent at the end of each iteration: date, items passed / failed / untestable,
the gap list.)

