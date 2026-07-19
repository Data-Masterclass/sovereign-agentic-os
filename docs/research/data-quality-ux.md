# Data Quality UX — Collate / Soda / Monte Carlo / Anomalo + Design + IA Placement

Date: 2026-07-19, status: advisory (decisions pending)

---

# Data Quality in the Sovereign Agentic OS — Research + UX Design + Action Plan

*Read-only research + design. No code changed. Every external claim is cited.*

---

## Part 1 — Current State (grounded in our files)

### 1.1 Our existing DQ engine — honest, thin, executable

**`os-ui/lib/data/dq.ts`** — a pure rule compiler. It supports exactly **five rule kinds**, each compiling to one governed *count-of-violations* `SELECT`:

| Rule | Violation predicate |
|---|---|
| `not_null(col)` | `col IS NULL` |
| `not_blank(col)` | `col IS NULL OR trim(cast(col AS varchar)) = ''` |
| `unique(col)` | rows in duplicate groups (`GROUP BY … HAVING count(*)>1`) |
| `accepted_values(col, values[])` | non-null value not in the set |
| `range(col, min?, max?)` | non-null value outside `[min,max]` |

Design contract (excellent, keep it): 0 violations ⇒ `pass`, >0 ⇒ `fail`, un-compilable/un-materialized ⇒ **`not_run`, never a fake pass** (the "honesty contract"). Aggregation into a single badge (`aggregateBadge`): any fail ⇒ `failing`, any pass & no fails ⇒ `passing`, nothing ran ⇒ `unknown`.

**`os-ui/lib/data/dq-run.ts`** — pure orchestration. Runs each compiled check via an injected `queryFn` bound to the **owner principal** (so a private `personal_<uid>` table reads AS its owner, Trino→OPA governed). Returns `{ fqn, ranAt, badge, results }`.

**Limits to name honestly:**
- **Rules only, no profiling-driven suggestion, no anomaly detection.** All five kinds are hand-authored assertions.
- **No history / trend.** `runQualityChecks` returns a point-in-time report; there is **no persisted time-series of results** — no pass-rate over time, no incident.
- **No freshness/volume/schema tests.** The competitor "5 pillars" (freshness, volume, schema, distribution) — see §2 — are entirely absent; we only have column-value rules.
- **No scheduling.** Checks run when a human clicks "Run checks" (or via MCP). Nothing runs them on a cadence.
- **No alerting/incident.** A `failing` badge is shown; nothing notifies anyone or opens an incident.
- Docstring already flags the intended future: *"dbt-core test integration is the future path."*

### 1.2 The staged Data tab

**`os-ui/lib/data/stages.ts`** — Data is staged **Define · Ingest · Refine · Publish · Use** (`DataBuilder.tsx` on `StageShell`, mirroring the Agent tab's `PHASES`). DQ currently spans two stages:
- **Define** (`hint`: *"Name it, document its columns, and author the data-quality rules it must meet."*) — authors rules.
- **Publish** (`hint`: *"Run the quality checks, then promote…"*) — runs checks; `completed:(c)=>c.refined`.

Gating reads **real dataset state** (`named`, `bronzeBuilt`, `refined`, `materialized`) — you can't Publish without a refined layer. No ✓ is faked.

### 1.3 The per-stage Data Assistant (the seed for everything in §4)

**`app/api/data/datasets/[id]/assistant/route.ts`** — one governed helper, scoped per stage, reusing `assistantComplete` (Langfuse-audited, cost-capped, honest 503/402, **no fake-AI fallback**; model only *suggests*, never mutates). **Define already returns strict JSON `{ description, columns, checks }`** — it already drafts DQ rules and column descriptions from name + column list. This is the exact hook §4 extends.

### 1.4 MCP DQ surface (already present)

`os-ui/lib/mcp/write-tools.ts` + `discovery-tools.ts`:
- `profile_dataset` — profiles a dataset (via `lib/data/profile.ts`: one-scan null-count / approx-distinct / min-max per column).
- `define_quality_rules` — appends the 5-kind rules to `dataset.yaml`.
- `run_quality_checks` — governed count-of-violations, per-rule pass/fail + badge, `not_run` honesty.

Same governed path as the UI. Missing: no "suggest rules from profile," no "read DQ history/incidents."

### 1.5 OpenMetadata — LIVE, and we already built the DQ write-back plumbing

This is the pivotal finding. **`os-ui/lib/data/openmetadata.ts` already contains `createOmTestCaseResult()`** — it PUTs to OM's real endpoint `/api/v1/dataQuality/testCases/{fqn}/testCaseResult` with `{ testCaseStatus: Success|Failed|Aborted, result, timestamp }`. It's wired into the **integrity-safe #163 write-back model**:
- **7 guards** (`openmetadata-sync.ts`): namespace isolation (`sovereign_os` Database Service + `Sovereign OS Products` Domain), **additive JSON-Patch only** (`buildAdditivePatch` — structurally cannot emit `remove`), `managedBy=SovereignOS` stamping, idempotent PUT, optimistic-concurrency `test` preconditions (412 → yield), dry-run preview, OM-side least-privilege **`sovereign-os-writer` bot** (write only on OS namespace).
- **Tested OM version range** `1.3.0–1.9.99`; every write **fails closed** outside it (`omVersionWritable`).

**But:** the sync *plan* today only PUTs tables + lineage + tags/props. It does **not yet provision Test Definitions, Test Cases, or Test Suites** — only the *result-append* verb exists, unused. That gap is exactly §6's build.

OM ingestion (catalog + dbt + query-log lineage) runs as a **K8s CronJob** (`openmetadata/ingestion` image, no Airflow) — `docs/components/openmetadata.md`. OM's own **native profiler + test-suite ingestion** can run on the same CronJob substrate.

### 1.6 The alert/notification path we can reuse

`lib/metrics/alert-store.ts` — durable rule registry (osMirror write-through, `os-alert-rules` OpenSearch index), evaluated by `/api/metrics/alerts/run`, **intended to be wired to a `*/5` CronJob**. This is the exact substrate for scheduled DQ runs + failure alerts (§5). The Monitoring tab already surfaces alerts and `get_monitoring_overview` exists in MCP.

---

## Part 2 — Competitive Synthesis (2026)

### OpenMetadata / Collate (the engine we already run)

Native **Profiler** + **Data Quality tests** at table and column level, run as data-quality pipelines; **no-code test authoring UI**; a **Data Quality (health) dashboard**; **Incident Manager**; **alerting on failure**; ingestion of **Great Expectations, dbt, Deequ, Soda** results ([OM DQ guide](https://docs.open-metadata.org/v1.12.x/how-to-guides/data-quality-observability/quality); [Atlan on OM DQ](https://atlan.com/know/openmetadata/data-quality/)). Architecture: `TestDefinition` (reusable), `TestCase` (a definition bound to a table/column), `TestSuite` (**Basic/executable** = 1:1 with an asset, **Logical** = reporting groups), results pushed to `TestCaseRepository` as **time-series**; failures become `TestCaseResolutionStatus` **incidents** with `incidentId`/`reviewers` and Close/Resolve tasks ([DeepWiki: OM DQ](https://deepwiki.com/open-metadata/OpenMetadata/2.3-data-quality-testing)). Built-in tests include **TableRowCountToBeBetween/ToEqual, TableColumnCountToEqual, TableColumnNameToExist, TableColumnToMatchSet, TableRowInsertedCountToBeBetween, TableCustomSQLQuery, TableDiff**, and column tests **columnValuesToBeNotNull, ToBeUnique, ToBeBetween, ToBeInSet, ValueLengthsToBeBetween, ValuesMissingCount, ValueMeanToBeBetween**, plus **freshness** ([OM test-definitions reference](https://docs.open-metadata.org/v1.12.x/how-to-guides/data-quality-observability/quality/data-quality-as-code/test-definitions)). REST under `/api/v1/dataQuality/{testDefinitions,testCases,testSuites}` and `.../testCases/{fqn}/testCaseResult`.

### Soda

**SodaCL** — declarative, human-readable checks-as-code (YAML), Git-native. **Soda Core (OSS)** = engine, runs in dbt/Airflow/CI, **no UI/alerting/tracking**; **Soda Cloud** = dashboards, alerting, anomaly detection, data contracts. **SodaGPT** turns plain language ("check new orders have customer IDs and no duplicates") into editable SodaCL. Anomaly detection rebuilt 2025 (Databricks AI Summit), "70% more accurate"; positioned as "AI-native automated DQ" ([Soda review 2025](https://www.siffletdata.com/blog/soda-review); [soda-core GitHub](https://github.com/sodadata/soda-core); [Soda anomaly docs](https://docs.soda.io/sodacl-reference/anomaly-detection)). **Lesson:** the readable check *and* the NL→check generator are the UX wins.

### Monte Carlo

The **5 pillars** — **Freshness, Volume, Schema, Distribution, Lineage** — with **ML monitors that learn "normal" and alert on deviation with zero rule-writing**; automated lineage + **monitoring-recommendation agent**; incident management with **blast-radius / RCA** ("which assets are affected, what to do next") ([MC 5 pillars](https://www.montecarlodata.com/blog-introducing-the-5-pillars-of-data-observability/); [What is data observability](https://montecarlo.ai/blog-what-is-data-observability)). **Lesson:** observability ≠ rules — freshness/volume/schema monitors give coverage *for free*, and lineage turns a failure into an impact story.

### Anomalo

**Unsupervised ML, no rules/thresholds** — learns typical ranges/distributions/relationships, flags deviation, uses **secondary checks to suppress false positives**; **instant RCA** (which columns/segments carry the anomalous data); **no-code** validation rules for the deterministic cases; alerts to Slack/email/tickets; **AIDA** plain-language analyst ([Anomalo self-driving DQ](https://www.anomalo.com/); [why unsupervised ML](https://www.anomalo.com/blog/why-data-quality-without-unsupervised-machine-learning-leaves-results-on-the-table/); [RCA](https://www.anomalo.com/blog/root-causing-data-failures/)). **Lesson:** "monitoring on by default, zero setup" is the headline; explicit rules are the exception, not the rule.

### The matrix

| Capability | OpenMetadata/Collate | Soda | Monte Carlo | Anomalo |
|---|---|---|---|---|
| **Auto-profiling** | Native Profiler | (Cloud) | AI profiles | core |
| **ML anomaly detection** | basic/emerging | (Cloud, rebuilt '25) | core (5-pillar) | core, unsupervised |
| **No-code authoring** | UI test builder | (Cloud) | yes | yes |
| **Checks-as-code** | YAML DQ-as-code | SodaCL | monitors-as-code | limited |
| **NL → check** | limited | SodaGPT | agent | AIDA |
| **Incidents** | Incident Manager | (Cloud) | RCA/blast-radius | RCA |
| **Alerting** | Observability alerts | (Cloud) | yes | yes |
| **Lineage-aware impact** | (catalog+lineage) | limited | yes | limited |

**Synthesized "simple + powerful" primitives** (the design targets these): **(1) auto-profile on ingest → (2) suggest checks from the profile (one-click accept) → (3) a health score + trend → (4) ML/heuristic monitors on by default (freshness/volume/schema) so users write few rules → (5) plain-language rules ("orders never negative") → NL→check → (6) failure → incident feed with RCA hint → (7) alert on the reuse path → (8) lineage tells you who's downstream.**

---

## Part 3 — Information Architecture: WHERE does DQ live?

The coordinator asked for an explicit, opinionated placement decision. Here it is.

| Option | For a non-expert user | Against |
|---|---|---|
| **(a) Woven implicitly** through Ingest/Refine/Publish | Zero new concepts | DQ becomes invisible/skippable; no single "is my data healthy?" answer; can't show trend/incidents coherently |
| **(b) Dedicated "Quality" STAGE** in the Data flow | One obvious place per dataset; matches the Agent-tab mental model ("there's a stage for that"); authoring + result + health all co-located; rides existing `StageShell` | Per-dataset only — no tenant rollup (solve in Monitoring) |
| **(c) Separate top-level "Quality" tab** | Central | A 2nd home for data splits the mental model ("do I go to Data or Quality?"); duplicates dataset context; heavy |
| **(d) Primarily in Monitoring** | Good for the ops persona | The person who *fixes* data lives in the Data tab; round-trips are painful; authoring-in-Monitoring is wrong altitude |
| **(e) Hybrid: author in Data, monitor/incidents in Monitoring** | Right division of labor at scale | Two surfaces to learn — acceptable IF the Data side is the clear primary |

**Recommendation: (b) as the primary, composed with (e) for the rollup — i.e. a dedicated "Quality" stage in the Data tab is the home of DQ; the Monitoring tab gets a read-only tenant/domain DQ overview + incident feed that deep-links back into that stage.**

Reasoning, Apple-simple:
1. **One concept, one place.** The Agent tab already taught users "each dataset has stages; there's a stage for each concern." Adding a **Quality** stage is *zero new navigation* — it's the pattern they already know. A separate tab (c) forces the "Data or Quality?" fork; weaving (a) makes health un-findable.
2. **Authoring belongs where the fixer works.** The person who documents a column and refines Bronze→Gold is the person who owns its quality. Keep them in one flow (rejects d).
3. **Health is per-dataset first.** "Is *this* dataset trustworthy?" is answered on the dataset. "How healthy is *my whole domain*?" is a Monitoring rollup — a *different question for a different persona*, so it's a read view, not a second authoring home.

**Concrete change:** promote DQ out of the shared Define/Publish stages into its own stage, giving **Define · Ingest · Refine · Quality · Publish · Use** (6 stages). *Author rules in Define still works, but the dedicated stage is where Quality is seen, run, and monitored.* Everything below is designed for this.

---

## Part 4 — The DQ UX (Apple-simple, matching the Agent-tab staged clarity)

### 4.1 The "Quality" stage — one screen, progressive disclosure

Gate: `enabled:(c)=>c.materialized` (there must be a table to check). `completed`: user ran checks this session with no open fails.

```
┌─ Quality ─────────────────────────────────────────── Assistant ⌄ ┐
│                                                                    │
│   Health   ▉▉▉▉▉▉▉▉▉░  92                    ⟳ last run 2h ago     │
│   ─────────────────────────────────────────────                   │
│   ✔ 11 passing   ✖ 1 failing   • 2 not run   ⚡ monitors on        │
│                                                                    │
│   ⚠ 1 needs attention                                              │
│   ┌──────────────────────────────────────────────────────────┐    │
│   │ ✖  amount is in range 0–100000        18 rows (0.3%)   →  │    │
│   │    18 orders have a negative amount. Likely refunds.      │    │
│   │    [ View rows ]  [ Explain ]  [ Snooze ]  [ Open incident ]│  │
│   └──────────────────────────────────────────────────────────┘    │
│                                                                    │
│   Suggested checks · from the profile               [ Accept all ] │
│   ┌──────────────────────────────────────────────────────────┐    │
│   │ ⊕ order_id is never null   (0 nulls in profile)     Add  │    │
│   │ ⊕ order_id is unique       (100% distinct)          Add  │    │
│   │ ⊕ status in {new,paid,shipped,cancelled} (4 seen)   Add  │    │
│   │ ⊕ created_at is fresh (< 24h)                       Add  │    │
│   └──────────────────────────────────────────────────────────┘    │
│                                                                    │
│   Your checks (11)                              [ + Add a check ]  │
│   ✔ order_id not null    ✔ order_id unique   ✔ email not blank …  │
│                                                                    │
│   ⚡ Auto-monitors (on by default)                      [ Manage ] │
│   ✔ Freshness   ✔ Row volume   ✔ Schema stable                    │
│                                                                    │
│                                            [ Run checks ]  ✓ gate  │
└────────────────────────────────────────────────────────────────────┘
```

Apple-simple principles applied:
- **Health score first, single number** (0–100), computed from pass-rate weighted by severity — the one glanceable answer. (Honesty preserved: score is `unknown`/greyed when nothing ran, never a fake 100.)
- **"Needs attention" is the only thing that shouts.** Passing checks collapse to chips. This is the Anomalo/MC lesson — surface the *exception*.
- **Suggested checks from the profile** is the hero interaction: one-click **Add**, or **Accept all**. This is where "powerful" hides behind "simple" — the user rarely authors from scratch (Soda/Anomalo/OM all suggest). Each suggestion cites its *evidence from the profile* ("0 nulls in profile", "4 categories seen").
- **Auto-monitors on by default** (freshness/volume/schema) — Monte-Carlo's insight that you get coverage without writing rules. Rendered as three toggles, on unless the user turns them off.
- **Plain-language add.** `+ Add a check` opens a single input: *"orders should never have a negative amount"* → the Assistant returns a concrete `range(amount, 0, ∞)` preview to accept/edit (Soda SodaGPT / Anomalo AIDA lesson).
- **Failure explains itself** in one sentence + a row peek + an "Open incident" affordance. No jargon.

### 4.2 The Data Assistant behaviors (§4 extension of the existing per-stage assistant)

The Quality stage adds an assistant mode to `app/api/data/datasets/[id]/assistant/route.ts` (`stage: 'quality'`), keeping the honest, cost-capped, suggest-only contract:

1. **Suggest checks from a profile** — input = profile stats (nulls, approx-distinct, min/max, top categories from `lib/data/profile.ts`) + samples; output = the strict JSON `checks[]` the Define mode already emits, *plus a `rationale` per check citing the profile evidence*. (Deterministic first — see §7 — the LLM only fills the gaps: descriptions, category-set naming, freshness column pick.)
2. **Auto-generate metadata** — column descriptions from name + profile + samples (already the Define path; reuse verbatim).
3. **Plain-language → rule** — "orders never negative" → `{rule:'range', column:'amount', min:0}` preview. Model suggests, user accepts, applied through the existing `define_quality_rules` path.
4. **Explain a failure** — given a failed check + violation count + a few offending rows, one plain-language sentence ("18 orders have a negative amount — likely refunds recorded as negatives"). Extends the existing `ingest`/`refine` "explain the error" modes.

### 4.3 The incident feed (per-dataset, in the stage; rollup in Monitoring)

A failing check the user chooses to track becomes an **incident** — acknowledge / assign / note root-cause / resolve — modeled on OM's Incident Manager so it maps 1:1 for write-back (§6). In the stage it's the "needs attention" card; the tenant view lives in Monitoring (§5).

---

## Part 5 — Dashboards + Alerts (Data + Monitoring)

### 5.1 Per-dataset health view (Data tab, Quality stage)
Health score + **trend sparkline** (pass-rate over the last N runs — requires persisting results, §Phase 1). Tiles: pass rate, freshness SLA (last-loaded vs expected cadence), open incidents, checks not-run.

### 5.2 Tenant/domain DQ overview (Monitoring tab, read-only)
```
┌─ Data Quality ─ Monitoring ───────────────────────────────────┐
│  Domain health   ▉▉▉▉▉▉▉▉░░ 84    ↓3 this week                 │
│  ┌── Datasets ranked by risk ────────────────────────────────┐ │
│  │ ✖ orders_gold      72  1 open incident   freshness 6h late │ │
│  │ ⚠ customers_gold   88  distribution drift on region        │ │
│  │ ✔ products_gold    99                                       │ │
│  └────────────────────────────────────────────────────────────┘ │
│  Open incidents (3)   ·   Alerts firing (1)   ·   Trend ▁▂▃▅▇  │
└────────────────────────────────────────────────────────────────┘
```
Each row deep-links to that dataset's **Quality stage** (the hybrid: monitor here, fix there). Scope-aware My/Domain/Company per the OS vocabulary standard.

### 5.3 Alerting — reuse the existing path
A DQ **CronJob** (mirror `metrics-alert-cronjob.yaml`) runs each dataset's checks + monitors on a cadence, persists a result row, and on new failure files a notification through the **`alert-store` / notification path** (Slack/email/inbox — the connectors already exist). Alert rule = "notify when dataset X drops below health H / any check fails / freshness SLA missed." No new alert engine — extend `AlertRuleRecord` with a DQ member type.

---

## Part 6 — OpenMetadata integration (leverage, don't rebuild)

**Principle: OM is the DQ engine of record for tests, results, and incidents. The OS is the governed *authoring + orchestration* surface.** We push OS-authored DQ into OM as first-class `TestDefinition`/`TestCase`/`TestSuite`/`testCaseResult`, so OM's **Data Quality dashboard + Incident Manager** reflect OS-governed DQ — reusing the already-built #163 write-back guards.

Map our 5 rule kinds → OM built-in test definitions (all exist — [test-definitions ref](https://docs.open-metadata.org/v1.12.x/how-to-guides/data-quality-observability/quality/data-quality-as-code/test-definitions)):

| OS rule | OM Test Definition |
|---|---|
| `not_null` | `columnValuesToBeNotNull` |
| `not_blank` | `columnValuesToBeNotNull` + `columnValueLengthsToBeBetween(min:1)` |
| `unique` | `columnValuesToBeUnique` |
| `accepted_values` | `columnValuesToBeInSet` |
| `range` | `columnValuesToBeBetween` |
| *(monitor)* freshness | table freshness / `tableRowInsertedCountToBeBetween` |
| *(monitor)* volume | `tableRowCountToBeBetween` |
| *(monitor)* schema | `tableColumnToMatchSet` / `tableColumnNameToExist` |

**Write-back composition (extends `openmetadata-sync.ts`, honoring all 7 guards):**
1. On promote/publish, `buildOmSyncPlan` gains a **DQ leg**: for each OS rule, PUT a **Basic (executable) TestSuite** bound to the gold mart's OM FQN, then PUT one **TestCase** per rule referencing the built-in `TestDefinition` — all under the `sovereign_os` namespace, `managedBy=SovereignOS`, idempotent, behind `test` preconditions. Endpoints: `PUT /api/v1/dataQuality/testSuites`, `PUT /api/v1/dataQuality/testCases`.
2. On each governed run (`dq-run.ts`), append the verdict via the **already-built** `createOmTestCaseResult()` → `PUT /api/v1/dataQuality/testCases/{fqn}/testCaseResult`. OM stores the time-series → its **DQ dashboard trend is populated for free**.
3. Failures flow into OM's **Incident Manager** (`TestCaseResolutionStatus`) — the OS incident feed (§4.3) reads/writes these so the two stay in sync.

**Composition with native OM profiler/ingestion:** the OM ingestion CronJob keeps running the **native profiler** (column metrics) and can ingest **dbt tests** — those coexist with OS-authored test cases in the same OM asset. Users see OS rules + native profiler + dbt tests unified in OM. The **honest boundary**: writes still **fail closed** outside OM `1.3.0–1.9.99` and require a valid writer-bot JWT; no live OM ⇒ DQ still runs governed-SQL locally and shows results in the stage (OM enrichment is additive, never a hard dependency).

---

## Part 7 — MCP surface (governed, same path as UI)

Extend the existing tools so a Claude Code / Codex user can drive the whole loop:

- **`profile_dataset`** *(exists)* — already returns profile stats.
- **`suggest_quality_rules`** *(NEW)* — input `datasetId`; runs the profile deterministically + the assistant, returns candidate rules `{rule,column,args,rationale}` **without writing**. Mirrors the UI "Suggested checks."
- **`define_quality_rules`** *(exists)* — accept suggestions / add plain rules.
- **`run_quality_checks`** *(exists)* — governed pass/fail + badge + `not_run`.
- **`get_quality_report`** *(NEW)* — read latest + trend (once results persist) + open incidents for a dataset. Read-only, governed.
- **`sync_quality_to_catalog`** *(NEW, gated)* — trigger the OM write-back leg (dry-run preview → apply after approval), reusing `previewOmSync`/`applyOmSync`.

Every tool runs AS the user, OPA-checked, audited — the MCP stays "a front door, not a back door."

---

## Part 8 — Phased Action Plan (low-risk-first; build-vs-leverage honest)

### Phase 0 — Foundation the rest needs (low risk, pure/testable)
- **Persist DQ results** as a time-series (new `os-dq-results` OpenSearch index, mirror the alert-store pattern). Unlocks health score + trend + incidents. *Build (small).*
- **Promote DQ to its own "Quality" stage** in `lib/data/stages.ts` + `DataBuilder.tsx` (IA decision, §3). Pure stage-def change + panel. *Build (small).*
- **Health score** aggregator (pure, in `dq.ts` family). *Build (tiny).*

### Phase 1 — Simple + powerful authoring (low risk, biggest UX win)
- **Suggest-checks-from-profile** — deterministic first: profile → obvious rules (0 nulls ⇒ not_null; 100% distinct ⇒ unique; small category set ⇒ accepted_values; numeric min/max ⇒ range). Assistant fills descriptions/rationale. One-click Add / Accept-all. *Leverage our profiler + assistant; build the mapping.*
- **Plain-language → rule** via the Quality assistant mode. *Extend existing assistant.*
- **MCP `suggest_quality_rules` + `get_quality_report`.** *Build (small).*

### Phase 2 — Monitoring on by default (medium; leverage OM + heuristics)
- **Freshness + volume + schema monitors**, on by default (Monte-Carlo lesson). Freshness = last-loaded vs expected cadence; volume = row-count band; schema = column-set stability. **Heuristic/statistical, NOT ML** to start (mean±k·σ bands from history) — cheap, explainable, sovereign-friendly.
- **Scheduled runs + alerts** — DQ CronJob (mirror `metrics-alert-cronjob.yaml`) → persist results → fire via alert-store/notification path. *Leverage.*
- **Monitoring-tab DQ overview + incident feed** (§5.2). *Build (medium).*

### Phase 3 — Catalog write-back (medium; mostly already built)
- **DQ leg in `buildOmSyncPlan`** — provision TestSuites/TestCases (map table §6), append results via the existing `createOmTestCaseResult`, sync incidents to OM Incident Manager. Governed, dry-run-first, all 7 guards. *Leverage #163; build the plan leg + test-def mapping.*

### Phase 4 — Bigger bets (flag for user decision)
- **ML/unsupervised anomaly detection** (Anomalo/Soda-class distribution monitors). **Decision needed:** build a small in-cluster statistical/ML monitor vs. lean on OM's evolving native anomaly features. Given EU-sovereign + open-source constraints, recommend **statistical monitors in-cluster** (no external SaaS) before any heavy ML.
- **Full incident RCA / blast-radius** using OM lineage (which downstream marts are affected). Powerful but a genuine build.
- **dbt-test as the execution path** (the `dq.ts` docstring's stated future) — only if we adopt dbt tests broadly.

### Decisions I need from you
1. **Confirm the IA:** promote DQ to a dedicated **Quality** stage (6 stages) — my recommendation — vs. keep it woven in Define/Publish.
2. **Auto-monitors default-ON** (freshness/volume/schema) acceptable, or opt-in?
3. **Anomaly detection stance:** in-cluster statistical monitors (sovereign) vs. defer to OM-native — and how far into ML you want to go.
4. **OM write-back for DQ:** turn it on now (it's built + guarded) or hold until you've validated the writer bot on the live tenant.

### Honest build-vs-leverage summary
- **Leverage (already have):** governed count-of-violations engine, profiler, per-stage assistant with JSON check-drafting, OM write-back guards + `createOmTestCaseResult`, alert-store/notification/CronJob substrate, OM native profiler+dbt ingestion.
- **Build (mostly small/medium):** result persistence, Quality stage, health score, profile→suggestion mapping, freshness/volume/schema monitors, DQ CronJob, Monitoring overview, the OM DQ sync leg, the new MCP tools.
- **Big bet (needs your call):** ML anomaly detection, lineage RCA.

**Sources:** [OM DQ guide](https://docs.open-metadata.org/v1.12.x/how-to-guides/data-quality-observability/quality) · [OM test-definitions](https://docs.open-metadata.org/v1.12.x/how-to-guides/data-quality-observability/quality/data-quality-as-code/test-definitions) · [Atlan: OM DQ 2026](https://atlan.com/know/openmetadata/data-quality/) · [DeepWiki: OM DQ](https://deepwiki.com/open-metadata/OpenMetadata/2.3-data-quality-testing) · [Soda review 2025](https://www.siffletdata.com/blog/soda-review) · [soda-core](https://github.com/sodadata/soda-core) · [Soda anomaly docs](https://docs.soda.io/sodacl-reference/anomaly-detection) · [MC 5 pillars](https://www.montecarlodata.com/blog-introducing-the-5-pillars-of-data-observability/) · [MC data observability](https://montecarlo.ai/blog-what-is-data-observability) · [Anomalo](https://www.anomalo.com/) · [Anomalo: unsupervised ML](https://www.anomalo.com/blog/why-data-quality-without-unsupervised-machine-learning-leaves-results-on-the-table/) · [Anomalo: RCA](https://www.anomalo.com/blog/root-causing-data-failures/)

**Key files:** `os-ui/lib/data/dq.ts`, `dq-run.ts`, `profile.ts`, `stages.ts` · `os-ui/components/data/DataBuilder.tsx` · `os-ui/app/api/data/datasets/[id]/assistant/route.ts` · `os-ui/lib/data/openmetadata.ts` (has `createOmTestCaseResult` → `/api/v1/dataQuality/testCases/{fqn}/testCaseResult`) · `os-ui/lib/connections/openmetadata-sync.ts` (7-guard write-back) · `os-ui/lib/mcp/write-tools.ts` (`define_quality_rules`, `run_quality_checks`) + `discovery-tools.ts` (`profile_dataset`) · `os-ui/lib/metrics/alert-store.ts` · `docs/components/openmetadata.md` · `charts/sovereign-agentic-os/templates/openmetadata/sovereign-os-writer.yaml`.
