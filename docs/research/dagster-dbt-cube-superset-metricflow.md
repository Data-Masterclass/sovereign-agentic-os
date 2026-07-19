# Semantic-Layer & Orchestration Architecture — Dagster + dbt Core + Cube + Superset (and MetricFlow)

Date: 2026-07-19, status: advisory (decisions pending)

---

# Semantic-Layer & Orchestration Architecture — Research Report for the Sovereign Agentic OS

*Prepared for a decision on whether to adopt "MetricFlow-define → Cube-serve," and how to wire the dbt / Cube / Superset / Dagster stack to 2026 best practice.*

---

## 1. Current-state map (verified against the repo)

I read the live code, not just the docs. Here is what actually owns **definition** vs **serving** vs **orchestration** today:

| Concern | Owner in the live OS | Evidence |
|---|---|---|
| **Metric/measure DEFINITION** | **The OS governed dataset registry.** `define_metric` mutates `measures: Measure[]` directly on the `Dataset` object (`os-ui/lib/data/dataset-schema.ts`). Three converging paths — form / agent / YAML — produce the same `Measure` (`lib/metrics/model.ts`). | `os-ui/lib/data/dataset-schema.ts:85`, `lib/metrics/README.md` |
| **Cube model GENERATION** | **os-ui, at runtime, from the registry.** `scaffoldCubeYaml(d)` builds cube+view YAML from the dataset's columns + measures; `buildCubeModels()` compiles the whole payload; a model-sync sidecar polls `GET /api/cube/models`. **There is no live dbt manifest in this path** — the code *comments* say "we follow the `cube_dbt` pattern" and "infer the column's type the way cube_dbt would… we have no live manifest in kind." | `os-ui/lib/data/metrics.ts:114-117`, `cube-models.ts` |
| **Metric/RLS GOVERNANCE** | **One policy compiler → two enforcement points.** `lib/data/policy/compiler.ts` compiles a dataset's visibility+grants into **both** the Trino OPA bundle **and** Cube access policies (row_level + member_level) from one source, with a conformance test proving they can't drift. Mask-in-Trino / hide-in-Cube is a locked decision. | `os-ui/lib/data/policy/compiler.ts:1-19` |
| **Physical mart MATERIALIZATION** | **Governed CTAS**, not dbt. Promotion runs a real Trino CTAS into `iceberg.<domain>.gold_<slug>` with a `tableQueryable` probe; the Cube binds `sql_table` to that FQN. | `os-ui/lib/data/publish-server.ts`, `metrics.ts:88-91` |
| **SERVING to BI** | **Cube SQL API** (`cube-sql:15432`, Postgres wire) as a per-domain `bi_<domain>` principal; Superset added as a `postgresql://` database. | `os-ui/lib/superset/cube-database.ts` |
| **Embedded dashboards / RLS at the edge** | **Superset guest tokens**, per-viewer `rls` clause derived from the *same* delegated identity that feeds Cube's securityContext. | `os-ui/lib/dashboards/embed.ts` |
| **dbt (the tool)** | **DEMO only.** `raw_orders → stg_orders → daily_revenue`, built by a post-install `dbt-trino` seed Job. Not wired to governed datasets. | `images/dbt/**`, `charts/.../templates/dbt/dbt-build.yaml` |
| **Dagster** | **DEMO only.** `@dbt_assets(manifest=…)` over the demo dbt project + a `hello_sovereign` proof-of-life asset. Not wired to governed datasets. | `images/dagster/repo.py` |
| **OpenMetadata** | Native Trino ingestion live; **dbt lineage ingestion wired but gated** behind `openmetadata.ingestion.dbt.enabled`. | `charts/.../templates/openmetadata/trino-ingestion.yaml` |
| **#146 analytics-as-code** | A git `analytics` repo mirrors the emitted dbt+cube models (diff-only writes) and has CI that runs `dbt parse` + Cube-YAML lint and publishes dbt artifacts to the S3 path OM reads. **Git = mirror; serving stays os-ui/registry.** | `os-ui/lib/data/analytics-repo.ts`, `charts/.../software/analytics-seed.yaml:290-313` |

**The one-sentence truth:** *In this OS, the metric definition home is the governed registry; Cube is a generated serving artifact; dbt and Dagster are demos; the RLS source of truth is a single policy compiler feeding both Trino-OPA and Cube.* Any recommendation must protect that compiler-as-single-source property — it is the platform's crown jewel.

---

## 2. Per-pair best-practice findings (2026, sourced)

### 2a. dbt Core ↔ Cube — `cube_dbt` moves MODELS, never METRICS

- `cube_dbt` is Cube's official Python package. It reads dbt's **`manifest.json`** and renders dbt **physical models (tables, columns, descriptions, types, PKs) as Cube cubes/dimensions.** It does **not** import metric definitions, run `dbt`, or manage transformations. Cube's July-2026 explainer: *"The integration doesn't import metric definitions… it assumes your tables are built and generates the layer that makes them queryable."* [docs.cube.dev/reference/data-modeling/cube_dbt](https://docs.cube.dev/reference/data-modeling/cube_dbt) · [cube.dev/blog/introducing-dbt-integration](https://cube.dev/blog/introducing-dbt-integration) · [github.com/cube-js/cube_dbt](https://github.com/cube-js/cube_dbt)
- **Canonical division of labour:** dbt owns transformation (staging→marts, tests); **Cube owns measures, joins, pre-aggregations, access control, multi-protocol APIs.** Sync = regenerate the Cube model from a fresh manifest (committed, URL-loaded, or dict from S3). [docs.cube.dev/recipes/data-modeling/dbt](https://docs.cube.dev/recipes/data-modeling/dbt)
- Multi-project namespacing is **not** an official story; `.filter(paths/tags/names)` is the only scoping mechanism. Latest `cube_dbt` = v0.6.3 (Oct 2025).

**Implication for us:** our Cube-YAML generator already does *exactly* the `cube_dbt` job (columns→dimensions, user-named measures) — just sourced from the registry instead of a manifest. Adopting `cube_dbt` literally would be swapping one metadata source for another, not gaining a metrics capability.

### 2b. Cube ↔ Superset — we're doing the recommended thing

- **Confirmed best practice:** *"Superset… connect[s] to Cube as to a Postgres database"* via the SQL API; cubes appear as tables, measures+dimensions as columns. Enable with `CUBEJS_PG_SQL_PORT` (docs use **15432** — exactly our port). [docs.cube.dev/admin/connect-to-data/visualization-tools/superset](https://docs.cube.dev/admin/connect-to-data/visualization-tools/superset) · [docs.cube.dev/reference/core-data-apis/sql-api](https://docs.cube.dev/reference/core-data-apis/sql-api)
- **Engine caveats:** the SQL API is Apache DataFusion + egg rewriting, *not* real Postgres. SQL support is tiered (regular "very limited" → with pushdown "extensive"). Known limits: aggregate must match measure type; **no cube-to-cube joins in pushdown** (joins must be pre-modeled); no custom aggregations on `number` measures under pushdown; `ORDER BY` that can't push down + >50k rows can yield wrong results; numeric dims are 64-bit float (integers >2^53 lose precision); planner blowups tuned via `CUBESQL_REWRITE_MAX_NODES`. [docs.cube.dev/reference/core-data-apis/sql-api/query-format](https://docs.cube.dev/reference/core-data-apis/sql-api/query-format)
- **RLS for a BI principal:** `checkSqlAuth(user)` returns `{ password, securityContext }`; a shared BI account can switch context per query via the `__user` virtual filter. Our design (per-domain `bi_<domain>` + `checkSqlAuth` → securityContext) matches the doc pattern. [docs.cube.dev/reference/core-data-apis/sql-api/security](https://docs.cube.dev/reference/core-data-apis/sql-api/security)
- **Embedding:** guest token with `rls` clauses, `EMBEDDED_SUPERSET` flag, `ENABLE_PROXY_FIX`, `SESSION_COOKIE_SAMESITE=None`, CSP `frame-ancestors` (preferred over `X-Frame-Options: ALLOWALL`). **Same-origin proxy (our `/tools/superset`) is the correct fix** — it sidesteps almost all the cross-origin cookie/XFO 403s in Superset issues #22258/#22005. [github.com/apache/superset/blob/master/superset-embedded-sdk/README.md](https://github.com/apache/superset/blob/master/superset-embedded-sdk/README.md)
- **One optional upgrade:** Cube Cloud's **Semantic Layer Sync** auto-creates/updates Superset datasets to mirror the Cube model. We hand-build bundles today (`scaffoldDashboardBundle`); Sync is a Cube-**Cloud** feature, so not for our self-hosted OSS Core — noted only for completeness. [docs.cube.dev/product/apis-integrations/semantic-layer-sync/superset](https://cube.dev/docs/product/apis-integrations/semantic-layer-sync/superset)

**Verdict: our Cube↔Superset wiring is on the 2026 golden path. Two dual-layer RLS layers (Cube securityContext + Superset guest-token clause) is deliberate defense-in-depth and correct.**

### 2c. Superset ↔ Dagster — no real integration; DIY REST glue only

- **There is no `dagster-superset` library.** Dagster's integrations catalog lists Looker/Tableau/Power BI/Sigma — **Superset is absent.** [docs.dagster.io/integrations/libraries](https://docs.dagster.io/integrations/libraries)
- **Realistic pattern:** a Dagster op *downstream of the mart build* authenticates to Superset (`/api/v1/security/login` → Bearer + CSRF + session cookie) and calls `PUT /api/v1/dataset/warm_up_cache` or `PUT /api/v1/chart/warm_up_cache`. Warmup only helps if you replicate the real dashboard filter context. [superset.apache.org/admin-docs/configuration/cache](https://superset.apache.org/admin-docs/configuration/cache/)
- **Often simpler:** Superset's own Celery-Beat warmup strategies (`TopNDashboardsStrategy`, `DashboardTagsStrategy`) may beat orchestrating from Dagster. Thumbnails are already async.

**Verdict: loose coupling is the state of the art here. Don't over-invest.**

### 2d. dbt Core ↔ Dagster — `dagster-dbt` is canonical and we already use its shape

- First-party. Current 2026 API = `DbtProject` + `@dbt_assets(manifest=…)` + `DbtCliResource.cli(["build"]).stream()`. Each model→asset; lineage from `ref()`/`source()`; dbt tests auto-load as asset checks; scheduling via `build_schedule_from_dbt_selection`; partitions via `partitions_def` + `--vars`. Best practice: precompile the manifest with `dagster-dbt project prepare-and-package` (prod) / `prepare_if_dev()` (dev). [docs.dagster.io/integrations/libraries/dbt/reference](https://docs.dagster.io/integrations/libraries/dbt/reference)
- Our `images/dagster/repo.py` already uses `@dbt_assets(manifest=MANIFEST)` + `DbtCliResource` — **correct API, just pointed at the demo project.**

### 2e. A canonical 4-way reference architecture?

**None published by any vendor.** What exists: three *pairwise* official integrations (dbt→Cube via `cube_dbt`; Cube→Superset via SQL API; dbt→Dagster via `dagster-dbt`) plus community "Dagster+dbt+DuckDB+Superset" stacks that treat Superset as a loose downstream consumer and **don't include Cube**. Community `dbt-to-cube` (ponderedw, ~11★, MIT) chains dbt→Cube→Superset dataset-sync but is not vendor-canonical. [github.com/ponderedw/dbt-to-cube](https://github.com/ponderedw/dbt-to-cube) · [datawise.dev portable stack](https://datawise.dev/a-portable-data-stack-with-dagster-docker-duckdb-dbt-and-superset)

---

## 3. MetricFlow → Cube — rigorous analysis and verdict

### What MetricFlow is in 2026
- **MetricFlow = the OSS SQL-generation engine** (Apache 2.0, `dbt-labs/metricflow`), part of dbt Core (v1.6+). Metrics are YAML: **semantic models** (entities/joins/dimensions/measures) + **metrics** on those measures. [docs.getdbt.com/docs/build/about-metricflow](https://docs.getdbt.com/docs/build/about-metricflow) · [getdbt.com/blog/open-source-metricflow-governed-metrics](https://www.getdbt.com/blog/open-source-metricflow-governed-metrics)
- **dbt Semantic Layer = the PAID hosted product** (dbt Cloud) that serves MetricFlow metrics through governed APIs: **JDBC (Arrow Flight SQL)** and **GraphQL**. [docs.getdbt.com/docs/use-dbt-semantic-layer/dbt-sl](https://docs.getdbt.com/docs/use-dbt-semantic-layer/dbt-sl) · [.../sl-jdbc](https://docs.getdbt.com/docs/dbt-apis/sl-jdbc)
- **Critical access split:** dbt Core users can *define + run* MetricFlow metrics locally via the **`mf` CLI** (SQL generation only). The **JDBC/GraphQL serving APIs require a paid dbt Cloud plan.** So "serve MetricFlow metrics over an API" is a paid capability; OSS gives you CLI/SQL-gen.

### Is "define in MetricFlow → serve via Cube" a supported pattern? **No.**
- **`cube_dbt` reads only physical dbt models, never MetricFlow.** No code path ingests `semantic_models:` / `metrics:` YAML. Measures are always authored *in Cube*. (Confirmed §2a.)
- **The only historical "Cube reads dbt metrics" path is doubly dead:** Cube's 2022 "dbt metrics meet Cube" read the **old `dbt_metrics` Jinja package** (not MetricFlow) via the Metadata API — and it carries an explicit *"no longer supported"* deprecation notice; separately dbt **deprecated `dbt_metrics` in v1.6 (July 2023)**. [cube.dev/blog/dbt-metrics-meet-cube](https://cube.dev/blog/dbt-metrics-meet-cube) · [docs.getdbt.com/blog/deprecating-dbt-metrics](https://docs.getdbt.com/blog/deprecating-dbt-metrics)
- **The community `dbt-to-cube` tool converts physical models, not MetricFlow metrics either.**
- I searched specifically for *any* official or community converter of MetricFlow semantic_models/metrics → Cube and found **none.**
- **Cube's own positioning:** complementary at the transformation boundary, **competitive at the metric boundary** — *"you define persistent logic once in dbt and govern the query-time metrics in Cube."* Cube even publishes a "dbt Semantic Layer alternatives (2026)" piece — i.e. it frames MetricFlow/dbt SL as the thing you'd pick *instead of* Cube for metrics, not upstream of it. [cube.dev/articles/dbt-semantic-layer-alternatives-2026](https://cube.dev/articles/dbt-semantic-layer-alternatives-2026)

### Dual-semantic-layer tradeoffs (define in one, serve in another)
- **Two sources of truth → guaranteed drift.** No converter exists, so you'd hand-maintain each metric twice in two YAML dialects. This negates MetricFlow's *entire* value prop (one Git-versioned, code-reviewed definition). Unwind Data (2026): *"One defines metrics. The other defines and serves them… picking the wrong one means rebuilding in 18 months."* [unwinddata.com/dbt-semantic-layer-vs-cube](https://unwinddata.com/dbt-semantic-layer-vs-cube)
- **RLS ownership diverges.** Cube owns RLS natively in its serving layer; MetricFlow/dbt SL largely delegates to the warehouse. If Cube serves, Cube is the effective governance boundary — so MetricFlow-as-source-of-truth is undermined the moment you enforce access. [typedef.ai semantic-layer-architectures](https://www.typedef.ai/resources/semantic-layer-architectures-explained-warehouse-native-vs-dbt-vs-cube)
- Even the most pro-hybrid write-ups stop at "MetricFlow for ad-hoc SQL, Cube pre-aggs for dashboards" — **never** "MetricFlow definitions served through Cube."

### Verdict on the user's preferred option — I respectfully disagree
**"MetricFlow-define → Cube-serve" is not a coherent, supported pattern, and it's a *poor* fit for THIS platform specifically.** Three reasons, in priority order:

1. **It breaks your single-source RLS guarantee.** Your crown jewel is `policy/compiler.ts`: one governed source → **both** Trino-OPA and Cube access policies, conformance-tested so they can't drift. MetricFlow would insert a *second* definition home whose native security model delegates to the warehouse — you'd either duplicate governance into MetricFlow YAML (drift) or keep enforcing in Cube (making MetricFlow a decorative definition layer). Either way you lose "one source, two enforcement points, provably consistent."
2. **Multi-tenant dynamic models fight MetricFlow's static-repo model.** Your OS *generates* per-domain namespaced Cube models at runtime from a live registry (`cubeNamespaced`, `<domain>__<slug>`, #155). MetricFlow expects a static, parsed dbt project with a manifest. Reconciling per-tenant dynamic generation with a compiled MetricFlow project is a large, ongoing impedance mismatch.
3. **There is no bridge to build on.** You'd be authoring the converter yourself, forever — a maintenance liability with zero upstream support, for a capability (metric definition) you already have.

**What I'd recommend instead:** keep the OS **registry as the single metric-definition source of truth**, keep **Cube as define+serve** (which is Cube's own recommended posture and what you already do). This is fully consistent with **decision #141** ("keep Cube; do NOT self-host MetricFlow serving"). If you ever want dbt in the metric story, the *only* coherent direction is the **inverse** of the user's instinct: **dbt-defines-MODELS (transform) + Cube-defines-METRICS** — i.e. make the marts real dbt models and feed their manifest to the Cube generator, while metrics stay in the registry/Cube. That's §4's "big bet," and it's genuinely optional.

---

## 4. Proposed action plan (phased, honest about effort/risk)

### Tier A — Low-risk wins (do these; they close real demo→production gaps)

**A1. Wire `dagster-dbt` to the governed marts (make Dagster real).** *Effort: M · Risk: low.*
Today Dagster only orchestrates the demo dbt project. The #146 `analytics` repo already emits governed dbt model SQL (`dbt/models/governed/<domain>/…`) and its CI runs `dbt parse` to produce a manifest. Point a Dagster `DbtProject` at that repo's manifest so governed marts appear as Dagster assets with lineage + asset-checks. This is squarely the canonical API you already use. **Decision needed:** does Dagster *materialize* governed marts, or stay observe-only while `publish-server` CTAS remains the executor? I recommend **observe-only first** (assets mirror the CTAS-built tables) to avoid two writers racing on the same Gold table.

**A2. Turn on OpenMetadata dbt lineage.** *Effort: S · Risk: low.*
The ingestion is wired and gated (`openmetadata.ingestion.dbt.enabled`), and #146 CI already publishes `manifest.json`/`catalog.json` to the S3 prefix OM reads. Once A-tier marts have real dbt models flowing, flip the flag so mart→metric→dashboard lineage lands automatically. **This is mostly a config flip once artifacts flow.**

**A3. Harden the Cube-SQL-API contract against the documented limits.** *Effort: S · Risk: low.*
Add guardrails/tests for the real SQL-API caveats: measure-type↔aggregate matching, no cube-to-cube joins in pushdown (pre-model joins in Cube), 2^53 integer-precision on numeric dimensions, and `CUBESQL_REWRITE_MAX_NODES`/stream-mode tuning for big domains. These are exactly the failure modes behind past empty-chart/#142 symptoms; codifying them prevents regressions.

**A4. (Optional, cheap) Dagster→Superset cache-warmup op.** *Effort: S · Risk: low.*
A downstream Dagster op that logs into Superset and `PUT …/dataset/warm_up_cache` for datasets whose mart just rebuilt. **Honest caveat:** warmup only helps if it replays real dashboard filters; Superset's own Celery-Beat `TopNDashboardsStrategy` may be simpler. Treat as nice-to-have, not core.

### Tier B — Medium bet (do only if you want dbt in the transformation story)

**B1. Make governed marts *real dbt models* (dbt-defines-models, Cube/registry-defines-metrics).** *Effort: L · Risk: medium.*
Migrate the governed CTAS in `publish-server.ts` to generated dbt models built by `dagster-dbt`, then feed the resulting **manifest** into the existing Cube-YAML generator via genuine `cube_dbt` (replacing the "infer types as cube_dbt would" heuristic in `metrics.ts:114`). **Metrics stay in the registry.** Benefits: real column types (not inferred), first-class lineage, reproducible transforms. **Risk:** two possible writers to Gold tables (dbt vs CTAS) — must pick one executor; and per-tenant dynamic model generation must reconcile with dbt's static-project assumptions. **This is the coherent "dbt + Cube" architecture — and notably it is the *opposite* of MetricFlow-define→Cube-serve.** Flag for user decision.

### Tier C — Big architectural bet — recommend AGAINST

**C1. MetricFlow as the metric-definition home, Cube as server.** *Effort: XL · Risk: high.*
Per §3: no supported bridge, breaks the single-source RLS compiler, fights multi-tenant dynamic generation, contradicts #141, and forces a bespoke MetricFlow→Cube converter you'd own forever. **My honest recommendation: do not pursue this.** If the goal behind the user's preference is "Git-versioned, code-reviewed metric definitions," you can get *most* of that value from Tier B (models in dbt/Git) plus the #146 analytics-repo mirror (metrics already mirrored to Git with CI lint) — **without** surrendering the registry as the governed source of truth.

### What needs the user's decision
1. **Tier A1:** Dagster observe-only vs materializer for governed marts. *(I recommend observe-only.)*
2. **Tier B1:** Do we want dbt to own transformation (real models + `cube_dbt` manifest), or keep governed CTAS as-is? *(Genuinely optional; only pursue if you want lineage/reproducibility badly enough.)*
3. **Tier C1:** Confirm we're closing the MetricFlow-serving door. *(I recommend yes — it re-affirms #141.)*

---

## 5. Bottom line

- **Cube↔Superset and dbt↔Dagster: you're already on the 2026 golden path** — the fixes are hardening (A3) and wiring the demos to production (A1/A2), not re-architecting.
- **Superset↔Dagster: loose REST glue is the state of the art** — don't over-invest (A4 optional).
- **MetricFlow→Cube: not supported, no bridge, wrong fit.** `cube_dbt` moves *models, not metrics*; MetricFlow and Cube are competing metric layers. Adopting it would duplicate every metric by hand and shatter your single-source RLS compiler. **I disagree with the user's preferred direction and recommend keeping the registry+Cube as define+serve (consistent with #141).** The only sensible role for dbt here is owning *transformation* (Tier B), which is the inverse of the MetricFlow instinct.

Every external claim above is cited inline with a URL.
