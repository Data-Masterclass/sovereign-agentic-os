# Metrics — golden path

## What this is

The Metrics tab is the OS's single source of truth for business numbers. A metric is a canonical Cube member — a named, governed definition of how a number is computed from a gold dataset. Metrics are the input to dashboards; no chart is permitted to query raw data directly. In the cross-tab spine, metrics sit between gold data and dashboards: data (Gold) → metrics → dashboards → big bets.

## How to build it

1. **Precondition: a governed Gold dataset.** Metrics require a Gold-tier dataset as their backing source. If no Gold dataset exists for your concept, complete the Data pathway first. Call `list_datasets` filtered to `tier: "gold"` to confirm.
2. **Dedupe check.** Call `list_metrics` to see what is already defined in your domain. Defining a metric that already exists by another name produces two competing definitions of the same number — avoid this.
3. **Define.** Call `define_metric` with:
   - `datasetId` — the ID of the Gold dataset
   - `name` — canonical business name (e.g. `gross_revenue`, `order_count`)
   - `aggregation` — one of `count`, `sum`, `avg`, `min`, `max`, `count_distinct`
   - `column` — required for all aggregations except `count`
   - `dimensions` — optional array of columns to group by
   The metric is registered as a Cube member immediately and is available to dashboards.
4. **Read the definition back.** Call `get_metric` with the metric `id` (`<datasetId>.<measure>`) to read back exactly what was registered — the aggregation + column, the backing dataset, the canonical Cube member and the generated Cube YAML — before iterating or charting it.
5. **Read the number.** Call `query_metric` with the metric `id` from `list_metrics` (`<datasetId>.<measure>`), optionally sliced by `dimensions` / `timeDimension` + `granularity`. This is how "what is revenue this month" resolves — through the SEMANTIC LAYER, never raw SQL: the tool accepts no SQL by construction, and Cube applies YOUR per-viewer row-level security (the securityContext is derived from your session identity), so the number you read is identical to the charts.

That is the complete flow. Metrics do not have a separate promotion step — they inherit the governance of their backing Gold dataset. A metric defined on a Personal Gold dataset is Personal; a metric on a Shared Gold dataset is Shared.

## What to consider

- **Gold only.** Attempting to define a metric on a Bronze or Silver dataset returns `bad_request`. Complete the data tier ladder first.
- **`count` needs no column.** Passing a `column` argument with `aggregation: "count"` is harmless but unnecessary. All other aggregations require a valid column name from the Gold schema.
- **One definition per number.** If two metrics compute the same thing under different names, dashboards will diverge. Check `list_metrics` carefully and reuse existing definitions. The OS does not enforce uniqueness by formula — that discipline is yours.
- **Dimensions are optional but powerful.** Declaring `dimensions` on a metric allows dashboard charts to slice by those columns without re-defining the metric. Add dimensions that are genuinely needed; do not over-specify.
- **Schema changes on Gold propagate.** If the backing Gold dataset schema changes in a breaking way, metrics that reference removed columns return `error` at query time. Version Gold datasets carefully.

## Governance

| Step | Role required |
|---|---|
| `list_datasets`, `list_metrics`, `get_metric`, `query_metric` | Creator |
| `define_metric` | Creator |
| Promotion | Inherited from backing Gold dataset |

OPA enforces that the caller has read access to the Gold dataset before `define_metric` is permitted. DLS on the dataset applies to all metric queries — a metric does not widen row access. Langfuse traces every metric query.

**Worked example:**

```
list_datasets({ domain: "analytics", tier: "gold" })
→ [{ id: "ds_01J...", name: "orders_v1", tier: "gold" }]

list_metrics({ domain: "analytics" })
→ [] — no metrics defined yet

define_metric({ datasetId: "ds_01J...", name: "order_count",
  aggregation: "count", dimensions: ["region", "channel"] })
→ { id: "mt_66E...", cubeMember: "analytics.order_count", registered: true }

define_metric({ datasetId: "ds_01J...", name: "gross_revenue",
  aggregation: "sum", column: "total_amount", dimensions: ["region"] })
→ { id: "mt_67F...", cubeMember: "analytics.gross_revenue", registered: true }

query_metric({ metricId: "ds_01J....gross_revenue", dimensions: ["region"] })
→ { member: "OrdersV1.gross_revenue", value: 128450,
    rows: [{ "OrdersV1.region": "DE", "OrdersV1.gross_revenue": 80210 }, ...],
    mode: "live", securityContext: { sub: "you", ... } }
```

Both metrics are now available as governed Cube members for dashboard chart binding, and `query_metric` reads the identical number the charts show.
