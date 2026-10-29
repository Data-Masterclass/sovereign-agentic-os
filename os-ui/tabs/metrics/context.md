# Metrics tab — build context

**Purpose:** One definition of every number. A metric is a governed Cube member defined on a dataset’s built GOLD version — define-here / explore / chart / ask-the-agent all read the identical number.

**Tools (MCP `metrics`):**
- `suggest_metrics(goal?)` — propose 3–6 high-value candidate metrics grounded in the caller's strategy (pillars), operating model, business processes (workflows) and visible datasets. Read-only (defines nothing). Each candidate carries name/description/why, an optional real `pillarId` + `processId` (workflow), a visible `datasetId`, a ready-to-define `form`, and an optional `crossEntity` flag when inputs span datasets (build a curated/joined dataset in Data first — never an invented join). Fabricated datasets/columns are dropped; `grounding` reports how much strategy/OM/process/data context informed it. Reasoning model, AS you, audited + cost-capped.
- `preview_metric(datasetId, name, aggregation, column?, dimensions?, timeDimension?, granularity?, limit?)` — transient preview, no persist. An unsaved draft is computed via governed SQL (mode `live (sql)`, same row security); a saved+delivered measure resolves via governed Cube (mode `live`). Returns rows + SQL + mode; `pending: true` only for shapes (rolling window / running total) the query engine computes after define.
- `define_metric(datasetId, name, aggregation, column?, dimensions?, …)` — persist a measure on a Gold, GOVERNED (asset/product) dataset. `dimensions` are persisted on the metric and rehydrate on edit. UPSERT by name — re-defining a metric of the same name updates it in place (no false "already defined"), which is how Edit saves. Returns the canonical member + generated Cube YAML. Returns `pending: true` if the query engine hasn't synced yet.
- `promote_metric(metricId)` — promote one rung (Personal→Domain or Domain→Company). Creator owner files a request; builder+ runs the consistency-gated transition directly.

**The full measure model** (all optional beyond aggregation — the same guided controls as the tab form; omit them all for a plain `{name,type,sql}` measure):
- `aggregation` ∈ `count` · `count_distinct` · `count_distinct_approx` (fast approximate distinct) · `sum` · `avg` · `min` · `max` · `number` (derived/ratio).
- `filter {column, operator, value}` — a FILTERED measure (operator ∈ equals/notEquals/gt/gte/lt/lte/set/notSet).
- `runningTotal: true` — cumulative running total; or `rollingWindow {amount, unit}` — trailing window (day/week/month/quarter/year). Mutually exclusive.
- `ratio {numerator, denominator}` — with `aggregation: "number"`, a derived measure over two EXISTING measures on the cube.
- `format` (currency/percent/number…) and `drillMembers` (drill-down exploration).

**Golden path:** in Data, build a Gold version, file `request_promotion` (kind `"dataset"`), a Builder runs `approve_promotion` → `define_metric` here → chart it with `create_dashboard`.

**Constraints:** the dataset must already be a governed asset/product (promote it in Data first — Cube reads the Trino mart). `count` needs no column; `sum`/`avg`/`min`/`max`/`count_distinct*` need a Gold column; `number` needs a `ratio`. Runs as you; audited.
