# Dashboards tab — build context

**Purpose:** Charts + tiles over GOVERNED metric members (Superset/Cube). A Domain/Company dashboard stays per-viewer RLS-scoped via the guest token.

**Tools (MCP `dashboards`):**
- `create_dashboard(name, view, charts[], id?)` — create (or replace, by `id`) a dashboard you own. Each chart references a governed metric member (e.g. `Orders.revenue`) — from any tier you can see, including your OWN (My-tier) metrics; the tab's picker groups them My · Domain · Company. Runs as you.

**Golden path:** `define_metric` in Metrics → `create_dashboard` here with ≥1 chart on that member → (a Builder/Admin later promotes/certifies it wider).

**Constraints:** every chart must bind to a governed metric member and a Cube `view` (one gold dataset’s view). Broadening the tier never broadens the rows. A creator builds their own; sharing wider is Builder/Admin.

**Every save is a git commit.** A dashboard is CODE in the owning domain's repository:
`dashboards/<slug>/dashboard.yaml` (plus a generated `README.md` and `dashboards/index.yml`), written
through the one commit path with `OS-Action` / `OS-Object: <id> (<name>)` / `OS-Surface` /
`OS-Request-Id`, authored as the acting user. `git log dashboards/<slug>/` is the dashboard's
version history. The format references **stable OS ids** — `metric:<id>` / `dataset:<id>` — and has
**no SQL field**: a dashboard can never put a number outside the metric registry or outside its
row-level security. An engineer can clone the repo, hand-edit the YAML and push; the receive gate
validates it with the same schema this tab uses, and a reference the domain does not have is
refused by name rather than silently rebound.

**Filter operators.** A panel filter compiles to `column IN (<values>)`, so `equals` and `in` are
the only servable operators. Anything else (`>=`, `between`, `contains`, …) is a typed
`bad_request` at write time AND at query time — never a silently dropped filter, which would show
an unfiltered number as though it were filtered. The bridge from a range is "define a filtered
metric in the Metrics tab and chart that".

**Charts.** Rendered with Apache ECharts through the OS's single chart surface
(`core/ui/charts`); line, area and bar are built by chart transformers derived from Apache Superset
source, vendored and attributed. The OS is not Apache Superset and does not run it.
