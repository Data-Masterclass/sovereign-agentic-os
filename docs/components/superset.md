# Superset — dashboards / BI

**What it is:** Apache Superset (Apache 2.0) — self-service dashboards on the governed marts
**THROUGH central Trino** and on **Cube** metrics. Web-only locally (no Celery/Redis). A demo
database connection (`trino`, Trino SQLAlchemy dialect) and a dataset on `analytics.daily_revenue`
are seeded.

## Access
```bash
kubectl -n agentic-os port-forward svc/agentic-os-superset 8088:8088
# http://localhost:8088
```
**Login:** `admin` / `superset-admin-local-dev`

## How to use it
- **Explore the seeded dataset:** *Datasets → daily_revenue* → Explore → build a chart
  (e.g., revenue by day). Save it to a dashboard.
- **Add a database:** *Settings → Database Connections → +* (e.g., point at Cube's SQL API or
  another Trino catalog). The `trino` connection is already there.
- **SQL Lab:** run ad-hoc SQL against the governed marts via Trino (row/column governed by OPA).

## FAQ
**Q: Async queries / caching?** Disabled locally (SimpleCache, no workers). Enable Redis +
the worker for async/cache in production.
**Q: Custom image?** Yes — `apache/superset:6.1.0` + `psycopg2` (metadata DB) + `trino[sqlalchemy]`
(the governed-mart connection); the stock image ships neither in its venv.
**Q: Superset's MCP server?** Not in 6.1.0 (roadmap). Agents create charts via Superset's MCP
when it lands upstream; for now the governed Trino `query` tool is the registered MCP tool.
