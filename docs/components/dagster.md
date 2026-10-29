# Dagster — orchestrator

**What it is:** Dagster (Apache 2.0) orchestrates the data tier — it loads the **dbt** project
as assets and runs `dbt build`; it's the spine for ingestion + metadata crawls. arm64-native
image (the official images are amd64-only). Backed by CNPG `dagster`.

## Access (UI)
```bash
kubectl -n agentic-os port-forward svc/agentic-os-dagster-webserver 3070:80
# http://localhost:3070  (no login locally)
```

## How to use it
- **Assets tab:** see the dbt models as assets (`daily_revenue`, `stg_orders`, `raw_orders`)
  plus `hello_sovereign`. **Materialize** them to run dbt against the warehouse.
- **Runs tab:** inspect run logs/status.

## FAQ
**Q: Does it actually run dbt?** Yes — materializing the dbt assets runs `dbt build` (validated:
RUN_SUCCESS). The warehouse creds reach the run pods via env + the warehouse Secret.
**Q: Daemon/user-code pods?** webserver (UI) + daemon (schedules/sensors) + user-code (gRPC,
hosts the definitions). All from one sovereign image.
