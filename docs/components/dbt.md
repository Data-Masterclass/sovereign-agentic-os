# dbt — transforms

**What it is:** dbt Core (Apache 2.0) transforms raw data into the **analytics warehouse**:
seed `raw_orders` → `stg_orders` (view) → `daily_revenue` (mart). Runs as a post-install Job
and as **Dagster** assets. Locally targets Postgres (CNPG `warehouse`); production targets
dbt-duckdb over Iceberg/Trino.

## How to use it
- It runs automatically on install (the warehouse is built). Inspect the result:
  ```bash
  kubectl -n agentic-os exec pg-1 -- psql -U postgres -d warehouse \
    -c "select * from analytics.daily_revenue order by order_date"
  ```
- **Re-run / orchestrate:** materialize the dbt assets in **Dagster** (Assets tab).
- **Add models:** edit `images/dbt/project/models/…`, rebuild the image, re-run.

## FAQ
**Q: No service — where's the UI?** dbt is a CLI/transform tool; its "UI" is Dagster (assets +
lineage) and the resulting tables (Cube/Superset read them).
**Q: Why dbt-postgres locally not dbt-duckdb?** A concurrent-safe shared warehouse Cube can
read; DuckDB is a single-writer file DB, awkward to share on kind. Production = dbt-duckdb/Iceberg.
