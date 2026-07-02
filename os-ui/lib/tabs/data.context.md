# Data tab — build context

**Purpose:** Query and build governed data products over the Iceberg marts (Trino) + Cube semantic layer; raw → staging → mart via dbt, registered in OpenMetadata.

**Tools (MCP `data`):**
- `query_data(sql)` — read-only SQL over the governed marts (Trino). OPA-authorized on your domain, Langfuse-traced.

**In-app data-product agent:** proposes dbt model SQL, materialization (view/table/incremental), tests (`not_null`, `unique`, `relationships`, `accepted_values`) and `schema.yml`. Output is a draft for review before it runs in Dagster.

**Golden path:** explore with `query_data` → define dbt model (staging → mart) → add tests → register as a data product → promote.

**Constraints:** read-only SQL only; principal = your primary domain (the OPA grant unit); every access is policy-checked and audited. No cross-domain read without a grant.
