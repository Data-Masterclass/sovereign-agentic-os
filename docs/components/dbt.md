# dbt — transforms (dbt-trino)

**What it is:** dbt Core (Apache 2.0) with the **dbt-trino** adapter — the single governed
transform path. It builds raw → `stg_orders` (table) → `daily_revenue` (incremental mart) as
**Iceberg tables via central Trino** (Polaris REST catalog). Runs as a post-install Job and as
**Dagster** assets. No dbt-duckdb / dbt-postgres on the governed path — one engine, one SQL dialect.

## How to use it
- It runs automatically on install (the marts are built through Trino). Inspect the result:
  ```bash
  kubectl -n agentic-os run q --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
    curl -sS http://query-tool:8000/query -H "Content-Type: application/json" \
    -d '{"sql":"select * from analytics.daily_revenue order by order_date"}'
  ```
- **Re-run / orchestrate:** materialize the dbt assets in **Dagster** (Assets tab).
- **Add models:** edit `images/dbt/project/models/…`, rebuild the image, re-run. The build emits
  `manifest.json` / `catalog.json` / `run_results.json` for OpenMetadata + `cube_dbt`.

## FAQ
**Q: No service — where's the UI?** dbt is a CLI/transform tool; its "UI" is Dagster (assets +
lineage) and the resulting Iceberg tables (Cube/Superset/the agent `query` tool read them through
Trino).
**Q: Why dbt-trino, not dbt-duckdb?** Trino is the single governed engine: it writes/maintains
Iceberg natively (DuckDB's Iceberg writes are immature) and applies OPA row/column governance.
DuckDB is scoped to the personal/sandbox lane only.
