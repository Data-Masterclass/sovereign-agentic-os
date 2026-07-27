# Data tab — build context

**Purpose:** Query and build governed data products over the Iceberg marts (Trino) + Cube semantic layer; raw → staging → mart via dbt, registered in OpenMetadata.

**Single engine:** ONE governed query engine — Trino/Iceberg. Your OWN data is a physical Iceberg table in `iceberg.personal_<uid>.*`, read AS you through the SAME governed path (owner-principal) as shared marts; there is no separate personal query engine. Promoted assets/products live in the domain schema.

**Tools (MCP `data`):**
- `query_data(sql)` — read-only SQL over the governed marts (Trino). OPA-authorized on your domain, Langfuse-traced.
- `get_dataset(datasetId)` — medallion versions, docs, data-quality rules, AND `cube.ready`/`cube.view`: a Domain/Company dataset with a built Gold is AUTO-REGISTERED as a queryable Cube model (dimensions from the gold columns, `count` fallback) — no define_metric needed.
- `ingest_dataset(datasetId, content, fileName?)` — inline CSV/JSON (≤ ~2 MB) → object store under YOUR prefix → data-runner → physical Bronze; registered only on a verified landing.
- `profile_dataset(datasetId, layer?)` — rowCount, null %, distinct, min/max, top values + preview through the governed query path (OPA masks apply).
- `transform_silver(datasetId, columns, ops)` — guided cleaning ops compiled server-side into ONE governed CTAS in your own schema; Silver registered only on ✓.
- `build_gold_join(datasetId, picks, dimensions, measures)` — join canView-checked dataset IDs into Gold; measures + lineage recorded only on ✓. **Key mapping / reconcile:** same-name keys auto-match; when the sides differ, set a join key’s `adapt` — `{mode:"text"}` (normalize case/whitespace/format) or `{mode:"cast",type}` (coerce both sides to one Trino type) — applied symmetrically to both sides.
- `define_quality_rules(datasetId, rules[])` — add executable DQ rules: `not_null`, `not_blank`, `unique`, `accepted_values` (with a values list), `range` (with min/max) on a column. Stored on the dataset.yaml spine.
- `run_quality_checks(datasetId)` — compile each rule to a governed COUNT-of-violations SQL, run AS the owner, and read a REAL pass/fail per rule + an aggregate badge (`passing`/`failing`/`unknown`). A rule that can't run (no built table) is `not_run`, never a fake pass. (dbt-core tests are the future path.)
- `define_metric(...)` — optional: ADD measures to the (already-queryable) Cube model.
- `set_dataset_sync(datasetId, connectionId, source, mode, schedule, …)` / `sync_dataset_now(datasetId, reset?)` / `get_sync_status(datasetId)` — scheduled incremental sync for connector-backed datasets (see below).

**Keep in sync (connector-backed datasets):** after create + first import/ingest from a warehouse, Kafka, Salesforce or Kajabi connection, call `set_dataset_sync` to keep the Bronze fresh on a schedule (presets every-15-minutes → weekly, or a 5-field cron; runs AS the dataset owner). Cursor semantics are HONEST and per-source: warehouse tables use your chosen timestamp/number column; Kafka is append-only on partition offsets; Salesforce locks to SystemModstamp; Kajabi locks to the resource's documented field — only `purchases` is true incremental (updated_at: new AND changed), contacts/customers/orders/form_submissions sync NEW records only (created_at — edits need a full refresh), cursorless resources (offers, products, transactions, …) are full-refresh only, and asking for more is a typed error, never fake incremental. `sync_dataset_now` triggers one run (reset:true = replace the copy + restart the cursor); `get_sync_status` reads config, next run, run history, watermark and QUARANTINE — ≥10 consecutive failures auto-pauses the schedule until a successful run (e.g. a manual sync) clears it.

**Cube auto-registration:** publishing a Gold dataset (promote → Domain/Company with Gold built) AUTOMATICALLY registers it as a Cube model in `/api/cube/models`. You do NOT run define_metric to get a queryable semantic model — measures are additive.

**Golden path:** `ingest_dataset` (Bronze) → `profile_dataset` (explore) → `transform_silver` (clean) → `build_gold_join` (reuse) → `define_quality_rules` + `run_quality_checks` → `document_dataset` → `request_promotion` → (auto Cube model) → optionally `define_metric` for measures.

**Constraints:** read-only SQL only; principal = your primary domain (or you, for your personal lane); every access is policy-checked and audited. No cross-domain read without a grant.
