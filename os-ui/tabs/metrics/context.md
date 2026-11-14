# Metrics tab — build context

**Purpose:** One definition of every number. A metric is a **dbt metric** (a `metrics:` entry on a `semantic_models:` measure) defined on a dataset’s built GOLD version and committed into the owning domain’s dbt project at `models/semantic/<model>.yml`. The OS serves it by compiling ONE governed Trino `SELECT` run as the viewer — Trino + OPA apply row/column security — so define-here / explore / chart / ask-the-agent all read the identical number. MetricFlow is never on the request path.

**Tools (MCP `metrics`):**
- `suggest_metrics(goal?)` — propose 3–6 high-value candidate metrics grounded in the caller's strategy (pillars), operating model, business processes (workflows) and visible datasets. Read-only (defines nothing). Each candidate carries name/description/why, an optional real `pillarId` + `processId` (workflow), a visible `datasetId`, a ready-to-define `form`, and an optional `crossEntity` flag when inputs span datasets (build a curated/joined dataset in Data first — never an invented join). Fabricated datasets/columns are dropped; `grounding` reports how much strategy/OM/process/data context informed it. Reasoning model, AS you, audited + cost-capped.
- `preview_metric(datasetId, name, aggregation, column?, dimensions?, timeDimension?, granularity?, limit?)` — transient preview, no persist. Every number is ONE governed Trino `SELECT` run as you (mode `live (sql)` for an unsaved draft, `live` for a saved metric, `offline-mock` labelled honestly offline). Returns rows + SQL + mode; `pending: true` only for a shape the OS compiler cannot serve (a rolling window at a grain it cannot express) — an honest refusal, never a number.
- `define_metric(datasetId, name, aggregation, column?, dimensions?, …)` — persist a measure on a Gold, GOVERNED (asset/product) dataset. `dimensions` are persisted on the metric and rehydrate on edit. UPSERT by name — re-defining a metric of the same name updates it in place (no false "already defined"), which is how Edit saves. Returns the canonical member, the dbt `metricType` it is emitted as, and the dbt `semantic_models:` + `metrics:` YAML committed into the domain’s dbt project. `pending: true` when the number cannot be served yet.
- `promote_metric(metricId)` — promote one rung (Personal→Domain or Domain→Company). Creator owner files a request; builder+ runs the consistency-gated transition directly.

**The full measure model** (all optional beyond aggregation — the same guided controls as the tab form; omit them all for a plain `{name,type,sql}` measure):
- `aggregation` ∈ `count` · `count_distinct` · `count_distinct_approx` (fast approximate distinct) · `sum` · `avg` · `min` · `max` · `number` (derived/ratio).
- `filter {column, operator, value}` — a FILTERED measure (operator ∈ equals/notEquals/gt/gte/lt/lte/set/notSet).
- `runningTotal: true` — cumulative running total; or `rollingWindow {amount, unit}` — trailing window (day/week/month/quarter/year). Mutually exclusive.
- `ratio {numerator, denominator}` — with `aggregation: "number"`, a ratio over two EXISTING metrics on the same dataset; emitted as a dbt `type: ratio` metric (never a measure carrying division SQL). Any other `number` formula is emitted as `type: derived`; a rolling window as `type: cumulative`.
- `format` (currency/percent/number…) and `drillMembers` (drill-down exploration).

**Golden path:** in Data, build a Gold version, file `request_promotion` (kind `"dataset"`), a Builder runs `approve_promotion` → `define_metric` here → chart it with `create_dashboard`.

**Constraints:** the dataset must already be a governed asset/product (promote it in Data first — the metric reads the Trino mart the dbt project builds). `count` needs no column; `sum`/`avg`/`min`/`max`/`count_distinct*` need a Gold column; `number` needs a `ratio`. Runs as you; audited.

**The dbt artefact (what an engineer sees):** `models/semantic/<model>.yml` in the domain repo for a
promoted dataset, `models/personal/<uid>/semantic/<model>.yml` while it is still personal (promotion
moves the file in one commit). The emitter targets dbt-semantic-interfaces 0.8.5 (= dbt-core 1.10) and
every field is valid on the dbt 1.9 the images carry. `list_metrics` returns each metric’s dbt
`metricType` and its `grain`. Anything with no faithful dbt form — a leading window, a ratio carrying
its own filter, a formula over a metric that is not emitted — is a NAMED refusal listed in the
generated project README, never wrong YAML. Query it from a clone with
`mf query --metrics <metric> --group-by metric_time__month`.
