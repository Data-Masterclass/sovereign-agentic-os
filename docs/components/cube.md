# Cube — semantic / metrics layer

**What it is:** Cube (Apache 2.0) defines **business metrics** on top of the dbt warehouse —
one consistent definition of `revenue`, `orders`, etc., served via REST / GraphQL / SQL APIs
to dashboards and agents. A `daily_revenue` cube is defined on `analytics.daily_revenue`.

## Access (dev playground UI)
```bash
kubectl -n agentic-os port-forward svc/cube 4001:4000
# http://localhost:4001  (Cube Playground — dev mode)
```

## How to use it
- **Playground:** pick the `daily_revenue` cube → measures (`total_revenue`, `total_orders`) +
  the `order_date` time dimension → run.
- **API:**
  ```bash
  curl http://localhost:4001/cubejs-api/v1/load \
    -H "Content-Type: application/json" \
    -d '{"query":{"measures":["daily_revenue.total_revenue"],"timeDimensions":[{"dimension":"daily_revenue.order_date","granularity":"day"}]}}'
  ```
- **Add a metric:** edit the model (`templates/cube/cube.yaml` data model) → `helm upgrade`.

## FAQ
**Q: Where's the data from?** The dbt-built warehouse (`analytics.daily_revenue`) in CNPG.
**Q: Who consumes Cube?** Superset dashboards and agents (consistent metric definitions).
