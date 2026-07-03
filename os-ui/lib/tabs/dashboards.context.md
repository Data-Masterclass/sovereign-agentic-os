# Dashboards tab — build context

**Purpose:** Charts + tiles over GOVERNED metric members (Superset/Cube). A shared/certified dashboard stays per-viewer RLS-scoped via the guest token.

**Tools (MCP `dashboards`):**
- `create_dashboard(name, view, charts[], id?)` — create (or replace, by `id`) a dashboard you own. Each chart references a governed metric member (e.g. `Orders.revenue`). Runs as you.

**Golden path:** `define_metric` in Metrics → `create_dashboard` here with ≥1 chart on that member → (a Builder/Admin later promotes/certifies it wider).

**Constraints:** every chart must bind to a governed metric member and a Cube `view` (one gold dataset’s view). Broadening the tier never broadens the rows. A creator builds their own; sharing wider is Builder/Admin.
