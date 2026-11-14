# Dashboards — golden path

## What this is

The Dashboards tab composes governed metrics into visual surfaces. Every chart in a dashboard binds to a canonical metric member — no chart queries raw data. `create_dashboard` persists the spec; panels **render natively at View time — Apache ECharts over the governed metric layer, no Superset import step**. Each panel queries AS THE VIEWER, so per-viewer row-level security is enforced live: two users viewing the same dashboard see only the rows their DLS grants allow. In the UI, dashboards follow the same artifact model as every context tab — ＋ New (a type chooser) lands in Edit, a tile opens a full-page View, ✎ Edit re-opens it; there is no staged flow. The viewer surface adds cross-filter chips (click a bar or slice to filter the whole dashboard through a governed WHERE), a drill-down drawer, a time-grain switcher, per-panel widths (⅓ / ½ / full), persisted default filters, and ⬇ CSV on table panels; any panel also expands full-screen (title or ⤢) — for a graph the chart large with its rows as a table and ⬇ CSV beneath, a table panel simply rendered large. The viz-type dropdown leads with pie · bar · table. In the cross-tab spine, dashboards sit downstream of metrics and upstream of big bets: metrics → dashboards → big bets.

## How to build it

1. **Inventory available metrics.** Call `list_metrics` to see all metrics in scope — your own (My), Domain and Company alike; you can build a dashboard on your OWN metrics, not just governed ones (the Dashboards tab's metric picker groups them My · Domain · Company). Identify every metric your dashboard will need. If a required metric does not exist, call `define_metric` to create it before proceeding — you cannot bind a chart to a metric that has not been defined.
2. **Fill gaps.** For any metric you need that is missing, call `define_metric` with the appropriate `datasetId`, `name`, `aggregation`, and optional `column` / `dimensions`. See the Metrics guide for the full flow.
3. **Create the dashboard.** Call `create_dashboard` with:
   - `name` — display name
   - `view` — the **governed view** the charts bind to (one gold dataset's dbt view, e.g. `Orders`)
   - `charts` — array of chart definitions, each containing:
     - `name` — chart label
     - `vizType` — one of `big_number_total`, `line`, `bar`, `table`
     - `metric` — the governed metric member to bind, e.g. `Orders.revenue`
     - `dimensions` — optional array of dimension names to break out by

4. **Read it back.** Call `get_dashboard` with the dashboard id to read back its charts and their governed metric members, the view they bind to, scope and owner — iterate by calling `create_dashboard` again with the same `id` (it replaces a dashboard you own).

That is the complete build flow. The dashboard renders natively at View time (ECharts over the governed metric layer); each panel query runs as the viewer, enforcing their DLS scope live — there is no Superset import and no guest-token round-trip.

## What to consider

- **Every chart must bind a metric member.** A chart that references a raw dataset column rather than a governed `metric` member returns `bad_request`. Define the metric first.
- **DLS is enforced per-viewer at query time.** Promoting a dashboard to a higher scope never widens the rows a viewer sees — every panel re-queries the governed metric layer as the viewer. DLS is a separate enforcement layer. Do not assume that a Domain dashboard gives viewers access to all rows.
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

OPA enforces metric read access at dashboard creation time. Every panel resolves through the governed metric layer as the viewer — one compiled Trino SELECT, with the viewer's DLS scope applied on each query — so the server never widens a viewer's rows. Langfuse traces every dashboard render.

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
    { name: "Total revenue", vizType: "big_number", metric: "Orders.revenue" },
    { name: "Orders by region", vizType: "bar", metric: "Orders.order_count",
      dimensions: ["Orders.region"] }
  ]
})
→ { id: "dash_sales_overview_ab12cd", tier: "personal", build: { native: true } }
```

The dashboard renders natively at View time (Apache ECharts on the governed metric layer). A domain admin then promotes it to Domain; each panel re-queries as its viewer, scoped to that viewer's own DLS.

The `vizType` field accepts the full set the UI offers — "big number" (and its legacy alias),
line, area, bar, pie and table — seven names in one enum, asserted equal to the type by
`lib/honesty.test.ts`, so the MCP door is never narrower than the UI door.

## The dashboard is code — and the second door is `git push`

Every save, from the UI or from `create_dashboard`, commits the dashboard to the owning domain's
repository:

```
dashboards/
  index.yml                       # slug → id, owner (opaque token), tier, view, panel count
  sales-overview/
    dashboard.yaml                # THE artefact — one human-editable file
    README.md                     # generated: what it charts, and how to work on it outside the OS
```

```yaml
apiVersion: os.sovereign/v1
kind: Dashboard
metadata:
  id: dash_sales_overview_ab12cd
  name: Sales Overview
  domain: analytics
  owner: fc4a050fe512             # opaque token — never a username or an e-mail address
  tier: domain                    # personal | domain | marketplace (the AUDIENCE ladder)
spec:
  view: Orders
  sources:
    - ref: dataset:ds_orders_gold
      view: Orders
    - ref: metric:met_orders_revenue
      member: Orders.revenue
  panels:
    - id: p_total-revenue
      name: Total revenue
      viz: big_number
      metrics: [Orders.revenue]
```

To work on it as an engineer:

```sh
git clone <os>/git/<domain>.git && cd <domain>
$EDITOR dashboards/sales-overview/dashboard.yaml
git commit -am "chart orders by channel" && git push
```

Three things the format guarantees, each of them tested:

1. **References are stable OS ids**, never an embedded query. There is no `sql:` field and the
   reader refuses one anywhere in `spec`, so a dashboard cannot smuggle a number past the metric
   registry.
2. **A missing id fails loudly.** A push that charts `metric:met_churn` in a domain that has no such
   metric is refused on your terminal, naming the file and the id. It is never rebound to a
   same-named member, because that would attach the panel to a different number.
3. **Generate → read → generate is byte-stable**, so regenerating commits nothing when nothing
   changed, and `git log` shows real changes only.

`index.yml` and `README.md` are **generated** — hand edits to them are ignored and regenerated.

Panel filters are limited to `equals` and `in`, because the governed query path compiles a filter to
an `IN` list. A `>=` is refused with a message saying so, rather than dropped: an unfiltered number
shown as a filtered one is the one thing this product may never do.

## Answering a question about a number (chat to the data)

For any question about a NUMBER, go through the semantic layer first: `list_metrics` → `query_metric`. Use `query_data` only when no governed metric member exists for the question, and then always show the SQL you ran and the row bound that applied.

An answer computed with `query_data` is AD HOC AND UNVERIFIED: say so in the answer, because the aggregation and the joins were chosen by you and not by the governed metric definition everyone else reads. A `query_metric` answer is the governed number and needs no such caveat.

NEVER aggregate, total, average or summarise a TRUNCATED result set. When a tool result carries `truncated: true`, the rows you were given are the FIRST n rows at the `rowLimit` ceiling — not a sample — so any number you compute over them is wrong. Say that the result was clipped, repeat the tool's own `message` verbatim, and offer a narrower query or a governed metric instead.

Discovery companions widen what you can SEE, never what you may DO: `query_metric` pulls in
`list_metrics`, `get_metric` and `get_dataset`; `create_dashboard` pulls in `list_dashboards`,
`list_metrics` and `get_dataset`.
