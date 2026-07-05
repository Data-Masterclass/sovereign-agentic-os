# Data tab — build context

**Purpose:** Query and build governed data products over the Iceberg marts (Trino) + Cube semantic layer; raw → staging → mart via dbt, registered in OpenMetadata.

**Tools (MCP `data`):**
- `query_data(sql)` — read-only SQL over the governed marts (Trino). OPA-authorized on your domain, Langfuse-traced.
- `ingest_dataset(datasetId, content, fileName?)` — inline CSV/JSON (≤ ~2 MB) → object store under YOUR prefix → data-runner → physical Bronze; registered only on a verified landing.
- `profile_dataset(datasetId, layer?)` — rowCount, null %, distinct, min/max, top values + preview through the governed query path (OPA masks apply).
- `transform_silver(datasetId, columns, ops)` — guided cleaning ops compiled server-side into ONE governed CTAS in your own schema; Silver registered only on ✓.
- `build_gold_join(datasetId, picks, dimensions, measures)` — join canView-checked dataset IDs into Gold; measures + lineage recorded only on ✓.

**In-app data-product agent:** proposes dbt model SQL, materialization (view/table/incremental), tests (`not_null`, `unique`, `relationships`, `accepted_values`) and `schema.yml`. Output is a draft for review before it runs in Dagster.

**Golden path:** `ingest_dataset` (Bronze) → `profile_dataset` (explore) → `transform_silver` (clean) → `build_gold_join` (reuse) → `document_dataset` → `request_promotion` → define metrics on the promoted Gold.

**Constraints:** read-only SQL only; principal = your primary domain (the OPA grant unit); every access is policy-checked and audited. No cross-domain read without a grant.
