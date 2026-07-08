# Data — golden path

## What this is

The Data tab is the foundation of the OS. It stores versioned, governed datasets that move through a Bronze → Silver → Gold tier ladder. Gold datasets are the only valid source for metric definitions; every downstream surface (metrics, dashboards, big bets) depends on governed gold. In the cross-tab spine, data feeds the entire analytics column and closes the loop from software output via Bronze ingestion.

## How to build it

1. **Reuse check.** Call `list_datasets` filtered to your domain. If the dataset already exists, call `get_dataset` and add a version rather than creating a duplicate. Call `query_data` to inspect existing rows before any write.
2. **Create.** Call `create_dataset` with `name`, `domain`, and `tier: "bronze"`. This creates a Personal asset in your domain.
3. **Add a Bronze version.** Two ways:
   - **Physical (preferred):** call `ingest_dataset` with inline CSV/JSON `content` (≤ ~2 MB in-band; bigger files via the UI upload — same pipeline). Your bytes land in object storage under your own prefix, the data-runner writes the real Iceberg table, and Bronze is registered **only when apply + a governed verify both pass** — no dot without a queryable landing.
   - **Registry-only:** call `add_dataset_version` with the raw source data. Bronze is append-only; no transformations required.
4. **Explore.** Call `profile_dataset` — rowCount, per-column null %, distinct counts, min/max, top values and a row preview, computed through the governed query path as you (OPA row filters and column masks apply). Use the real column names it returns in the next step.
5. **Promote to Silver.** Two ways:
   - **Guided physical (preferred):** call `transform_silver` with `columns` + guided `ops` (rename / cast / trim / normalize / drop / filter / dedupe). The OS compiles ONE governed CTAS into your own schema, runs it as you, and registers Silver only on a ✓ apply+verify.
   - **Authored:** call `add_dataset_version` with `tier: "silver"`, supplying your authored dbt SQL. Include `not_null` and `unique` tests in the version payload. Silver requires at least one passing test.
6. **Promote to Gold.** Two ways:
   - **Join/reuse (preferred):** call `build_gold_join` with dataset IDs to join (each re-resolved against what you may read — never a table name), join keys, projected dimensions and derived measures. **Key mapping / reconcile:** same-name keys auto-match with no extra config; when the two sides differ, set the join key’s optional `adapt` — `{mode:"text"}` normalizes both sides (lower+trim+cast-to-varchar) so keys differing only by case/whitespace/format line up, or `{mode:"cast", type}` coerces both sides to one Trino type (e.g. an id stored as varchar on one side, integer on the other). The adaptation wraps BOTH sides so the equality stays symmetric. Gold + lineage + measures are recorded only on ✓. On promotion the Gold auto-registers as a Cube model (measures are additive via `define_metric`, not required to make it queryable).
   - **Authored:** call `add_dataset_version` with `tier: "gold"`. Gold locks the schema — downstream metric definitions depend on it.
7. **Add data-quality rules (optional, recommended).** Call `define_quality_rules` with dropdown-style rules — `not_null`, `not_blank`, `unique`, `accepted_values` (with a values list), `range` (with min/max) on a column — then `run_quality_checks` to compile each to a governed COUNT-of-violations SQL and run it AS the owner for a REAL pass/fail per rule + an aggregate badge. A rule that can't run (no built table) is reported not-run, never a fake pass.
8. **Document.** Call `document_dataset` with a `description`, `owner`, and at least one `tag`. Documentation is the gate to promotion; this step is required before filing.
9. **File a promotion request.** Creator calls `request_promotion` to move the dataset from Personal to Shared. The dataset stays Personal until a Builder acts.
10. ⛔ **Builder approves.** A Builder or Admin calls `approve_promotion`. The dataset becomes visible to domain members — and if it has a built Gold, it is **auto-registered as a queryable Cube model** (view + dimensions from the gold columns + a `count` measure) with no `define_metric` step. Confirm via `get_dataset` → `cube.ready`.
11. **Add measures (optional).** Call `define_metric` only to ADD named measures to the already-queryable Cube model.

**Note:** `query_data` is read-only at any point in the flow. Re-promoting an already-Shared dataset returns `conflict` — treat it as idempotent.

## What to consider

- **Reuse first.** Duplicate datasets fragment the single source of truth. Always run `list_datasets` before `create_dataset`.
- **Tests are mandatory for Silver.** A version without `not_null` or `unique` tests will fail promotion to Silver.
- **Documentation gates promotion.** Calling `request_promotion` on an undocumented dataset returns `bad_request`. Call `document_dataset` first.
- **Gold locks schema.** Adding a breaking schema change to a Gold dataset that has downstream metric definitions returns `conflict`. Version carefully.
- **Idempotency.** `add_dataset_version` is safe to retry; it creates a new immutable version. `create_dataset` on a name that already exists returns `conflict`.
- **Physical builds are honest.** `ingest_dataset`, `transform_silver` and `build_gold_join` register a version ONLY when the real apply + governed verify pass; a failed build is a typed error and registers nothing. Offline, the report is labelled `offline-mock` — never a fake ✓.
- **The compiled CTAS is server-side.** `transform_silver`/`build_gold_join` never accept raw SQL — you send guided ops / dataset IDs and the OS compiles one allowlisted statement into YOUR OWN schema, executed as you (OPA masks every read).

## Governance

| Step | Role required |
|---|---|
| `list_datasets`, `get_dataset`, `query_data`, `profile_dataset` | Creator |
| `create_dataset`, `add_dataset_version`, `document_dataset` | Creator (own work) |
| `ingest_dataset`, `transform_silver`, `build_gold_join` | Creator (own schema, runs as you) |
| `request_promotion` | Creator |
| ⛔ `approve_promotion` | Builder or Admin |

OPA enforces domain scope on every read. DLS filters rows at query time regardless of tier. A creator cannot approve their own promotion — the `forbidden` error is final; ask a Builder.

**Worked example:**

```
list_datasets({ domain: "analytics", tier: "gold" })
→ [] — no existing gold dataset for this concept

create_dataset({ name: "orders_v1", domain: "analytics", tier: "bronze" })
→ { id: "ds_01J...", tier: "bronze", state: "personal" }

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

document_dataset({ id: "ds_01J...", description: "Raw order events from Shopify", tags: ["orders"] })
→ { documented: true }

request_promotion({ id: "ds_01J..." })
→ { state: "pending_approval", requestId: "pr_99..." }
```

A Builder then calls `approve_promotion({ requestId: "pr_99..." })` to make it Shared.
