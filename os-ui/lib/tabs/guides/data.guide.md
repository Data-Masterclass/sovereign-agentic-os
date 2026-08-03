# Data — golden path

## What this is

The Data tab is the foundation of the OS. It stores versioned, governed datasets — the raw, cleaned and business layers are kept under the hood, but you work with **one artifact per dataset**: ＋ New (a type chooser) lands you in Edit; a tile opens a full-page View. Datasets split by ORIGIN — **ingested** (data you bring in) and **curated** (a new table composed from datasets you already trust). The business (Gold) layer that metrics read is **materialized automatically** — for a single-table ingested dataset it passes through with no manual join step; for a curated dataset it is the composition you defined. Gold is the source metric definitions read; every downstream surface (metrics, dashboards, big bets) depends on it. In the cross-tab spine, data feeds the entire analytics column and closes the loop from software output via ingestion.

The MCP tools below are the same governed path the UI drives; they still name the physical layers (`ingest`/`transform_silver`/`build_gold_join`) so a tools-only client can drive each step explicitly. In the UI these are Ingestion, Transformation, Composition — and for a plain ingested dataset the business layer is auto-materialized, so you never file a manual "publish to Gold" step.

## How to build it (ingested dataset)

1. **Reuse check.** Call `list_datasets` (no arguments — it returns everything you can see, grouped by origin) and scan for your domain and concept. If the dataset already exists, call `get_dataset` and add a version rather than creating a duplicate. Call `query_data` to inspect existing rows before any write.
2. **Create.** Call `create_dataset` with `name` and (optionally) `domain` plus seed `columns` docs. This creates a My-scope, ingested dataset in your domain (yours, no approval needed).
3. **Ingest the data.** Two ways:
   - **Physical (preferred):** call `ingest_dataset` with inline CSV/JSON `content` (≤ ~2 MB in-band; bigger files via the UI upload — same pipeline). Your bytes land in object storage under your own prefix, the data-runner writes the real Iceberg table, and the landing is registered **only when apply + a governed verify both pass** — no dot without a queryable landing.
   - **Registry-only:** call `add_dataset_version` with `datasetId` and `layer: "bronze"`. The raw layer is append-only; no transformations required.
4. **Explore.** Call `profile_dataset` — rowCount, per-column null %, distinct counts, min/max, top values and a row preview, computed through the governed query path as you (OPA row filters and column masks apply). Use the real column names it returns in the next step.
5. **Transform (optional).** Call `transform_silver` with `columns` + guided `ops` (rename / cast / trim / normalize / drop / filter / dedupe). The OS compiles ONE governed CTAS into your own schema, runs it as you, and registers the cleaned layer only on a ✓ apply+verify. In the UI this is the **Transformation** section (Save Transformations). Skip it and a clean ingested dataset passes straight through — the business layer materializes automatically, no join required, and it auto-registers as a queryable Cube model (measures are additive via `define_metric`, not required to make it queryable).
6. **Curated datasets — compose instead.** To build a NEW table by joining datasets you already trust, create it as a curated dataset and call `build_gold_join` with the explicit base dataset plus dataset IDs to join (each re-resolved against what you may read — never a table name), join keys, kept/renamed columns, derived fields and measures. **Key mapping / reconcile:** same-name keys auto-match; when the two sides differ, set the join key’s optional `adapt` — `{mode:"text"}` normalizes both sides (lower+trim+cast-to-varchar) so keys differing only by case/whitespace/format line up, or `{mode:"cast", type}` coerces both sides to one Trino type (e.g. an id stored as varchar on one side, integer on the other). The composition wraps BOTH sides so the equality stays symmetric. The composed table + lineage + measures are recorded only on ✓, and it auto-registers as a queryable Cube model. In the UI this is the curated dataset's **Composition** section (Save Composition). (Ingested datasets never join — that is the curated path.)
7. **Add data-quality rules (optional, recommended).** Call `define_quality_rules` with dropdown-style rules — `not_null`, `not_blank`, `unique`, `accepted_values` (with a values list), `range` (with min/max) on a column — then `run_quality_checks` to compile each to a governed COUNT-of-violations SQL and run it AS the owner for a REAL pass/fail per rule + an aggregate scorecard. A rule that can't run (no built table) is reported not-run, never a fake pass. In the UI this is the **Checks** section (Save Data Quality Checks); its curated rule suggestions need a built, queryable Gold to profile against — until then the section says so rather than returning an empty list silently.
   - **Fix failures (optional).** For a FAILING rule, call `propose_quality_fixes` (read-only): the rule re-runs, failing rows are sampled honestly ("showing N of M"), and the assistant proposes either ONE batch column-transform (guard-validated, previewed before→after with a residual count MEASURED by SQL) or per-row fixes (only when the dataset declares a `unique` key column and ≤200 rows fail — row identity is never guessed), or an honest "needs a structural fix" diagnosis (e.g. `unique` duplicates). Then `apply_quality_fixes` (edit-gated) executes exactly the accepted changes as ONE whitelisted MERGE as you, re-runs the rule (a fix that didn't fix stays red), and records a remediation run with the pre-apply Iceberg snapshot id — revert is via Console (no governed rollback shape). Nothing is ever applied without the explicit apply call.
8. **Document.** Call `document_dataset` with `datasetId`, a `description` and (recommended) per-column `columns` docs. Documentation is the gate to promotion; this step is required before filing.
9. **File a promotion request.** Owner calls `request_promotion` with `kind: "dataset"` and the dataset `id` to promote it from My to Domain. The dataset stays My-scope until a domain admin acts.
10. ⛔ **Domain admin approves.** A domain admin (or tenant admin) calls `approve_promotion`. The dataset becomes visible to domain members — and its materialized business layer is **auto-registered as a queryable Cube model** (view + dimensions from the columns + a `count` measure) with no `define_metric` step. Confirm via `get_dataset` → `cube.ready`. Until promoted, the dataset carries a "not certified" chip in the UI.
11. **Add measures (optional).** Call `define_metric` only to ADD named measures to the already-queryable Cube model.

**Note:** `query_data` is read-only at any point in the flow. Re-promoting an already-Domain dataset returns `conflict` — treat it as idempotent.

**Keep it in sync (connector-backed datasets).** When the Bronze came from a connection (warehouse table, Kafka topic, Salesforce object, Kajabi resource) rather than a one-off upload, call `set_dataset_sync(...)` after create + first ingest to keep it fresh on a schedule (preset or cron), `sync_dataset_now(...)` to run once immediately (`reset: true` replaces the copy and restarts the cursor), and `get_sync_status(...)` for config, next run, run history and watermark. Cursor semantics are honest per source — Kafka is append-only on partition offsets, Salesforce locks to `SystemModstamp`, Kajabi locks to each resource's documented field (only `purchases` detects edits; created_at-only resources sync new records; cursorless resources are full-refresh only — asking for more is a typed `bad_request`). After ~10 consecutive failures the schedule auto-quarantines; fix the source and run `sync_dataset_now(...)` to resume.

## What to consider

- **Reuse first.** Duplicate datasets fragment the single source of truth. Always run `list_datasets` before `create_dataset`.
- **Ingested vs curated.** An ingested dataset carries data you bring in and never joins — a clean one passes straight through to a queryable business layer. A curated dataset composes a NEW table from datasets you already trust (explicit base + joins + kept/renamed columns + derived fields). Pick the origin at ＋ New.
- **Auto-gold, no manual publish step.** For a single-table ingested dataset the business layer materializes automatically via pass-through — there is no separate "build Gold" or "publish to Gold" action. Curated datasets materialize the composition you saved.
- **Tests on the cleaned layer.** An authored `add_dataset_version(layer: "silver")` still expects `not_null`/`unique` tests in its body.
- **Documentation gates promotion.** Calling `request_promotion` on an undocumented dataset returns `bad_request`. Call `document_dataset` first (the UI **Documentation** section, Save Documentation).
- **Schema changes propagate.** A breaking schema change to a dataset that has downstream metric definitions returns `conflict`. Version carefully.
- **Idempotency.** `add_dataset_version` is safe to retry; it creates a new immutable version. `create_dataset` on a name that already exists returns `conflict`.
- **Physical builds are honest.** `ingest_dataset`, `transform_silver` and `build_gold_join` register a version ONLY when the real apply + governed verify pass; a failed build is a typed error and registers nothing. Offline, the report is labelled `offline-mock` — never a fake ✓.
- **The compiled CTAS is server-side.** `transform_silver`/`build_gold_join` never accept raw SQL — you send guided ops / dataset IDs and the OS compiles one allowlisted statement into YOUR OWN schema, executed as you (OPA masks every read).

## Governance

| Step | Role required |
|---|---|
| `list_datasets`, `get_dataset`, `query_data`, `profile_dataset` | Creator |
| `create_dataset`, `add_dataset_version`, `document_dataset` | Creator (own work) |
| `ingest_dataset`, `transform_silver`, `build_gold_join` | Creator (own schema, runs as you) |
| `request_promotion` | Creator (owner) |
| ⛔ `approve_promotion` | Domain admin (or tenant admin) |

OPA enforces domain scope on every read. DLS filters rows at query time regardless of tier. A creator cannot approve their own promotion — the `forbidden` error is final; ask a domain admin.

**Worked example:**

```
list_datasets({})
→ { mine: [], domain: [], marketplace: [] } — no existing dataset for this concept

create_dataset({ name: "orders_v1", domain: "analytics" })
→ { id: "ds_01J...", tier: "dataset", visibility: "private" }

ingest_dataset({ datasetId: "ds_01J...", fileName: "orders.csv",
  content: "order_id,net_amount\n1001,250.00\n1002,90.50" })
→ { ok: true, mode: "live", table: "iceberg.personal_you.bronze_orders_v1",
    rowCount: 2, bronzeRegistered: true }

profile_dataset({ datasetId: "ds_01J..." })
→ { available: true, layer: "bronze", rowCount: 2,
    columns: [{ name: "net_amount", nullPct: 0, min: "90.5", max: "250.0", ... }] }

transform_silver({ datasetId: "ds_01J...", columns: ["order_id", "net_amount"],
  ops: [{ kind: "cast", column: "net_amount", type: "double" },
        { kind: "filter", column: "order_id", op: "not_null" }] })
→ { ok: true, target: "iceberg.personal_you.silver_orders_v1", silverRegistered: true }

document_dataset({ datasetId: "ds_01J...", description: "Raw order events from Shopify",
  columns: [{ name: "net_amount", description: "Order value in EUR" }] })
→ { id: "ds_01J...", description: "Raw order events from Shopify", ... }

request_promotion({ kind: "dataset", id: "ds_01J..." })
→ { status: "pending", approvalId: "apr_99...", kind: "dataset_promote", ... }
```

A domain admin then calls `approve_promotion({ approvalId: "apr_99..." })` to make it Domain-scoped.
