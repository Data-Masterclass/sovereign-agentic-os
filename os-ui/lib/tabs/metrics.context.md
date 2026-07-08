# Metrics tab — build context

**Purpose:** One definition of every number. A metric is a governed Cube member defined on a dataset’s built GOLD version — define-here / explore / chart / ask-the-agent all read the identical number.

**Tools (MCP `metrics`):**
- `define_metric(datasetId, name, aggregation, column?, dimensions?, …)` — persist a measure on a Gold, GOVERNED (asset/product) dataset. Returns the canonical member + generated Cube YAML.

**The full measure model** (all optional beyond aggregation — the same guided controls as the tab form; omit them all for a plain `{name,type,sql}` measure):
- `aggregation` ∈ `count` · `count_distinct` · `count_distinct_approx` (fast approximate distinct) · `sum` · `avg` · `min` · `max` · `number` (derived/ratio).
- `filter {column, operator, value}` — a FILTERED measure (operator ∈ equals/notEquals/gt/gte/lt/lte/set/notSet).
- `runningTotal: true` — cumulative running total; or `rollingWindow {amount, unit}` — trailing window (day/week/month/quarter/year). Mutually exclusive.
- `ratio {numerator, denominator}` — with `aggregation: "number"`, a derived measure over two EXISTING measures on the cube.
- `format` (currency/percent/number…) and `drillMembers` (drill-down exploration).

**Golden path:** in Data, build a Gold version, file `request_promotion` (kind `"dataset"`), a Builder runs `approve_promotion` → `define_metric` here → chart it with `create_dashboard`.

**Constraints:** the dataset must already be a governed asset/product (promote it in Data first — Cube reads the Trino mart). `count` needs no column; `sum`/`avg`/`min`/`max`/`count_distinct*` need a Gold column; `number` needs a `ratio`. Runs as you; audited.
