# Lakehouse Import & Exposure — approved design (2026-08-05)

Owner-approved redesign of how the OS imports/connects data from external lakehouses
(AWS Glue/Athena, Databricks Unity/Delta, Snowflake, BigQuery, OneLake, …).
Replaces the Data tab's "Pull from a product" with a governed Connect → Expose → Adopt flow.

## Approved decisions

1. **Adopted datasets enter at Domain tier** (`asset`, visibility `domain`) — exposure
   (Company/admin) + adoption (Domain admin) are the two governance gates; a required
   at-adopt description feeds the documentation gate; certification keeps its full gate.
2. **Adoption floor: `domain_admin`** (roleAtLeast).
3. **Ad-hoc SQL extract** (`/api/data/sandbox` `pull-extract`): all first-class UI removed;
   the governed server action stays for Developer/personal-lane use.
4. **Cube/metrics v1: synced copies only.** Live federated datasets get preview/Talk/
   query/grants from day one; the UI says plainly "define metrics on a synced copy".

## Scale & tier assumptions (owner-set)

- Connected catalogs hold ~500–1,000 tables; platform admin exposes ≤ ~500; a domain
  admin adopts 10–50. Browse = search/filter/multi-select over ~1k rows, no web-scale
  indexing. The petabyte concern is TABLE SIZE (query guardrails, honest sampling).
- Imported data is curated **silver or gold** — no raw/bronze import, no refinement
  stages on connected datasets. Further refinement uses the existing curated/compose
  path with the connected dataset as a source.

## The flow

**Connect** (exists): warehouse connection → one-click Trino catalog registration
(`lib/connections/warehouse/k8s-registration.ts`), gated by `EXTERNAL_CONNECTORS_ENABLED`.

**Catalog snapshot** (new `lib/connections/warehouse/catalog-snapshot.ts`): per-connection
cached listing built from governed `SHOW SCHEMAS`/`SHOW TABLES` (columns lazily via
`DESCRIBE` on expand). Refresh button + optional CronJob (`connections.catalogRefresh`,
nil-safe, default off). Drift = diff of consecutive snapshots; flagged on exposures and
adopted datasets. Freshness always shown as "snapshot from <takenAt>" — never fabricated.
OpenMetadata is NOT the browse backend; OM mirroring stays additive/namespaced and
compatible with the external-customer-OM track.

**Expose** (new, platform admin, connection detail): `ExposureSet { id, connectionId,
name, domains[], mode: 'live'|'sync', tier: 'silver'|'gold', tables[{schema,table}],
syncDefaults?, note?, revoked? }` persisted via the registry mirror
(`lib/connections/exposures.ts`). UI: snapshot browser (search, group-by-schema,
multi-select, select-whole-schema) + exposure form; admin-only.

**Exposure compiles to OPA — closes a real security gap.** Today `policies/trino.rego`
defaults allow and the compiler emits entries only for governed `iceberg.*` marts, so a
live-registered external catalog is readable by EVERY authenticated principal. Fix ships
with exposures, as one unit:
- rego: fail-closed floor — non-`iceberg` catalog + no governance entry ⇒ row filter
  `false` (and write deny), additive style matching the personal-lane rule.
- compiler: each non-revoked exposure emits
  `data.governance.tables["<catalog>.<schema>.<table>"] = { domain, visibility:'shared',
  shared_with: exposure.domains }`.

**Adopt** (new, domain admin, Data tab): "+ New dataset → From a connection" (third card;
replaces "Pull from a product" in the BronzePanel, which becomes upload-only). Lists only
tables exposed to the caller's domain(s), grouped connection → exposure set. Adoption
creates `origin:'connected'` with:

```
connected?: { connectionId, exposureId, source:{catalog,schema,table},
              mode:'live'|'sync', tier:'silver'|'gold',
              status:'ok'|'drifted'|'source-revoked' }
```

- Only `versions[tier].built = true`; no bronze; builder shows a **Source** stage
  (connection, table, mode, freshness/drift, sync runs) instead of Ingest/Refine —
  precedent: `origin:'curated'` hiding stages.
- **Live**: `builtLayerFqn`/`versionTarget` branch on `d.connected` → FQN =
  `catalog.schema.table`, principal = viewer's domain principal. Preview/profile/DQ/Talk/
  `query_data` inherit through that one seam. Dataset grants compile to OPA keyed on the
  external FQN.
- **Sync**: existing engine (`sync-run-server.ts`/`sync-sql.ts`/`sync-cron.ts`) retargeted
  to `iceberg.<domainSchema>.<tier>_<slug>` (not personal bronze); watermarks/quarantine/
  maintenance reused verbatim; freshness = last successful run.

**Revocation propagates honestly**: compiler withdraws OPA entries (live reads →
zero rows immediately); bound datasets get `status:'source-revoked'` with an explicit
banner; synced copies freeze (sync disabled, CronJob removed) but keep the last-landed
data; `dataset_source_revoked` trace + owner notification. Never silent.

## Guardrails (table size)

Live preview = LIMIT 100. Live profile/DQ = `TABLESAMPLE`/LIMIT-bounded, labeled
"sampled, approximate — computed on ~N rows"; executable DQ on live tables requires
explicit confirmation and recommends the synced copy. 15 s governed statement timeout
(`lib/infra/governed.ts`) stated honestly. Sync full-refresh of very large tables warns
and steers to a cursor. Only real numbers surfaced (run durations, rows moved).

## MCP + assistants

New tools: `list_exposure_sets` / `create_exposure_set` / `update_exposure_set` /
`revoke_exposure_set` (admin), `refresh_connection_catalog`, `list_exposed_tables`
(domain-scoped), `adopt_exposed_table` (domain_admin). `import_warehouse_table` stays
for back-compat, description points at adoption. `get_dataset` gains the `connected`
block. Existing tab-scoped assistant routing carries "expose all sales schemas to the
Commerce domain" / "adopt orders from the Databricks connection" with no new machinery.

## Phases (independently shippable)

- **0** Retire "Pull from a product" (BronzePanel segment, tutorial copy, tests).
- **1** Exposure sets + catalog snapshot + OPA fail-closed floor (security-critical; one
  unit). Live check: unexposed external table reads zero rows for a creator; exposed
  table reads for the assigned domain only.
- **2** Adopt flow, Live mode (`origin:'connected'`, FQN seam, third create card, Source
  stage, revocation states, sampling labels).
- **3** Sync mode (domain-tier SyncTarget, adopt-dialog sync config, drift flags,
  freshness).
- **4** MCP parity + assistant journeys + optional additive OM mirroring.

Audit facts of record: "Pull from a product" = free-SQL Trino extract into personal
bronze via `/api/data/sandbox` (`pull-extract`/`land-bronze`), unrelated to Marketplace
import; warehouse connectors/registration/discovery/import are real behind
`EXTERNAL_CONNECTORS_ENABLED` (default off); no `kind:'federated'` dataset exists today;
scheduled incremental sync engine is real (see `docs/data-sync-scaling.md`).
