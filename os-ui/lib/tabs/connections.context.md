# Connections tab — build context

**Purpose:** Connect governed external data sources (Google Drive, Notion, Salesforce, Kajabi, Slack, databases, MCP/API endpoints) so apps and agents can consume them BY REFERENCE — the raw credential is stored server-side and never leaves the OS.

**Tools (MCP `connections`):**
- `list_connections` — the connections you can see (reuse first).
- `get_connection(connId)` — one connection (metadata + sync state, never the secret).
- `create_connection(name, template, endpoint?, credential?, domain?)` — a PERSONAL connection.
- `test_connection(connId)` — probe it (live | offline).
- `promote_connection(connId)` — Builder+: My → a DOMAIN source.

**Golden path:** `list_connections` (reuse) → `create_connection` (Personal) → `test_connection` → ⛔ Builder+ `promote_connection` → apps consume via `use_connection(appId, ref)` BY REFERENCE.

## Lakehouse: connect → snapshot → organize → expose → adopt

For a WAREHOUSE connection (Glue/Athena, Databricks, Snowflake, BigQuery, OneLake, …), the governed way to bring external tables into the OS is **expose → adopt**, not a raw import. This closes a real security gap: an unexposed live external catalog reads ZERO rows for everyone (the fail-closed OPA floor); an exposure is the gate that opens exactly the named tables to exactly the named domains.

1. **Register + snapshot.** Register the Trino catalog (register_warehouse_catalog, Builder+), then `refresh_connection_catalog` (admin) to cache the `SHOW SCHEMAS/TABLES` listing. `get_catalog_snapshot` reads it — freshness is always "snapshot from <takenAt>", drift is `prevDiff` (+added/−removed), never fabricated.
2. **Organize (optional, AI).** `classify_catalog` (admin) groups tables into a folder taxonomy — names-first with a capped column-enriched pass. It NEVER invents folders; a low-confidence table lands in Unsorted with a plain reason; human moves win permanently. `get_catalog_classification` reads the merged placements + category counts + the honest `lastRunDetail`. Suggested, not verified.
3. **Expose (admin, Company-tier).** `create_exposure_set(connId, name, domains[], mode: live|sync, tier: silver|gold, tables[])` grants the listed tables to the domains and COMPILES STRAIGHT TO OPA. `update_exposure_set` / `revoke_exposure_set` recompile immediately — a dropped/revoked table closes to zero rows on the next recompile. `list_exposure_sets` reads them.
4. **Adopt (⛔ domain_admin, Data tab).** `list_exposed_tables` shows only tables exposed to YOUR domain(s); `adopt_exposed_table(exposureId, schema, table, description)` creates a governed Domain-tier dataset (`origin:'connected'`). **Live** federates every read through the external FQN; **sync** lands a scheduled governed copy (define metrics on a synced copy). A required description feeds the documentation gate.

**Revocation is honest.** `revoke_exposure_set` withdraws OPA entries (live reads → zero rows immediately) AND freezes every adopted dataset (`connected.status`='source-revoked'), tears down its sync CronJob, notifies its owner, and traces the revocation per dataset — a synced copy keeps its last-landed data; nothing is silent. The UI Revoke button and the MCP tool share ONE revoke-and-propagate seam (front-door invariant).

import_warehouse_table still exists as a one-shot personal/developer CTAS copy, but its description now points at expose→adopt as the governed path.

**Constraints:** any user may connect a per-user (personal-OAuth) account; service-credential templates and promotion require a Builder/Admin. Exposure CRUD + catalog refresh/classify are ADMIN; adoption floors at domain_admin. The model NEVER sees raw credentials — the reference is the contract. External endpoints must be on the egress allowlist. Every action runs as you, OPA-checked and audited.
