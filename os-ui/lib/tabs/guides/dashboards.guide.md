# Dashboards — golden path

## What this is

The Dashboards tab composes governed metrics into visual surfaces. Every chart in a dashboard binds to a canonical metric member — no chart queries raw data. `create_dashboard` persists the spec; panels **render natively at View time — Apache ECharts on the governed Cube layer, no Superset import step**. Each panel queries AS THE VIEWER, so per-viewer row-level security is enforced live: two users viewing the same dashboard see only the rows their DLS grants allow. In the UI, dashboards follow the same artifact model as every context tab — ＋ New (a type chooser) lands in Edit, a tile opens a full-page View, ✎ Edit re-opens it; there is no staged flow. The viewer surface adds cross-filter chips (click a bar or slice to filter the whole dashboard through a governed WHERE), a drill-down drawer, a time-grain switcher, per-panel widths (⅓ / ½ / full), persisted default filters, and ⬇ CSV on table panels; any panel also expands full-screen (title or ⤢) — for a graph the chart large with its rows as a table and ⬇ CSV beneath, a table panel simply rendered large. The viz-type dropdown leads with pie · bar · table. In the cross-tab spine, dashboards sit downstream of metrics and upstream of big bets: metrics → dashboards → big bets.

## How to build it

1. **Inventory available metrics.** Call `list_metrics` to see all metrics in scope — your own (My), Domain and Company alike; you can build a dashboard on your OWN metrics, not just governed ones (the Dashboards tab's metric picker groups them My · Domain · Company). Identify every metric your dashboard will need. If a required metric does not exist, call `define_metric` to create it before proceeding — you cannot bind a chart to a metric that has not been defined.
2. **Fill gaps.** For any metric you need that is missing, call `define_metric` with the appropriate `datasetId`, `name`, `aggregation`, and optional `column` / `dimensions`. See the Metrics guide for the full flow.
3. **Create the dashboard.** Call `create_dashboard` with:
   - `name` — display name
   - `view` — the **Cube view** the charts bind to (one gold dataset's view, e.g. `Orders`)
   - `charts` — array of chart definitions, each containing:
     - `name` — chart label
     - `vizType` — one of `big_number_total`, `line`, `bar`, `table`
     - `metric` — the governed metric member to bind, e.g. `Orders.revenue`
     - `dimensions` — optional array of dimension names to break out by

4. **Read it back.** Call `get_dashboard` with the dashboard id to read back its charts and their governed metric members, the view they bind to, scope and owner — iterate by calling `create_dashboard` again with the same `id` (it replaces a dashboard you own).

That is the complete build flow. The dashboard renders natively at View time (ECharts on the governed Cube layer); each panel query runs as the viewer, enforcing their DLS scope live — there is no Superset import and no guest-token round-trip.

## What to consider

- **Every chart must bind a metric member.** A chart that references a raw dataset column rather than a governed `metric` member returns `bad_request`. Define the metric first.
- **DLS is enforced per-viewer at query time.** Promoting a dashboard to a higher scope never widens the rows a viewer sees — every panel re-queries the Cube layer as the viewer. DLS is a separate enforcement layer. Do not assume that a Domain dashboard gives viewers access to all rows.
- **list_metrics before create_dashboard.** Building a dashboard with metric IDs you have not verified exist will cause `not_found` errors inside the `charts` array. Always inventory first.
- **list_dashboards before creating a new one.** Call `list_dashboards` to confirm you are not duplicating an existing view of the same metrics.
- **Filters are additive.** Chart-level `filters` narrow the metric query further. They do not override DLS — they compose with it.

## Governance

| Step | Role required |
|---|---|
| `list_metrics`, `list_dashboards`, `get_dashboard` | Creator |
| `define_metric` | Creator |
| `create_dashboard` | Creator (My scope by default, no approval) |
| Promote to Domain | Domain admin |
| Promote to Company (certify) | Admin |

OPA enforces metric read access at dashboard creation time. Every panel resolves through Cube as the viewer, with the viewer's DLS scope applied on each query — the server never widens a viewer's rows. Langfuse traces every dashboard render.

**Worked example:**

```
list_metrics({ domain: "analytics" })
→ [{ member: "Orders.order_count" }, { member: "Orders.revenue" }]

list_dashboards({ domain: "analytics" })
→ [] — no existing dashboard for this view

create_dashboard({
  name: "Sales Overview",
  view: "Orders",
  charts: [
    { name: "Total revenue", vizType: "big_number_total", metric: "Orders.revenue" },
    { name: "Orders by region", vizType: "bar", metric: "Orders.order_count",
      dimensions: ["Orders.region"] }
  ]
})
→ { id: "dash_sales_overview_ab12cd", tier: "personal", build: { native: true } }
```

The dashboard renders natively at View time (ECharts on the governed Cube layer). A domain admin then promotes it to Domain; each panel re-queries as its viewer, scoped to that viewer's own DLS.
