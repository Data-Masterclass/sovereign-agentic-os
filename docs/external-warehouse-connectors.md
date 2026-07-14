<!-- SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) -->
# External-warehouse connectors

How the Sovereign Agentic OS federates external lakehouses (AWS Glue/Athena,
Snowflake, BigQuery, Databricks, Azure Fabric) into ONE governed query path.

> **Status — Phase 1 (code-complete, unit-tested, feature-flagged; NOT yet
> validated against a live source).** Glue prop-generation + the federated-dataset
> transform are pure and tested. The live seams (dynamic catalog reload, OM
> ingestion, cloud auth) are marked `Phase 1b:` and require a real source to
> validate. Everything is gated OFF behind `EXTERNAL_CONNECTORS_ENABLED` (default
> off), so nothing appears in the UI/runtime until an operator turns it on.

## The core idea

The OS does NOT spin up a per-source MCP for each warehouse. It federates every
external lakehouse through the **central governed Trino** — the same query engine,
the same OPA row/column policy, the same `query` tool the whole OS already uses.

**Each external source = one Trino catalog.** Mount `hive.metastore=glue` (or the
Snowflake/BigQuery/Delta connector) as a catalog and every table in that source is
addressable as `catalog.schema.table`, live, without copying a byte. Metadata
mirrors into **OpenMetadata** for discovery/lineage. When a team wants a governed,
owned copy — a "data product" — they **import** it: a CTAS into the OS's own
Iceberg lakehouse, which reuses the existing promote/materialize path. Federation
is the discovery/query on-ramp; import is materialization.

## The five-layer pattern

Every source travels the same five layers (see `os-ui/lib/connections/warehouse/`):

| # | Layer | What it is | Phase |
|---|-------|-----------|-------|
| 1 | **Connection** | A typed warehouse config + a vault credential ref. Auth is cloud-native identity where possible (IRSA/Workload Identity/Managed Identity); NO static keys in Trino props. | 1 (types) |
| 2 | **Trino catalog** | `trinoCatalogProps(source)` renders the `<catalog>.properties` map → a file at `/etc/trino/catalog/<name>.properties`. | 1 (Glue done) |
| 3 | **OM ingest** | The external catalog's tables mirror into OpenMetadata for discovery + lineage. | 1b (interface only) |
| 4 | **Federated dataset** | A read-only registry entry (`kind: 'federated'`) pointing at `catalog.schema.table`. Distinct from a materialized sovereign dataset. | 1 (type + mapper) |
| 5 | **Import as product** | CTAS materializes the external table into the OS Iceberg lakehouse — reuses the existing promote/materialize path. | 2 |

Layers 1, 2 (Glue), and 4 are real and unit-tested in Phase 1. Layer 3's interface
(`TableDescriptor` → `FederatedDataset`) is defined and tested as a pure transform;
the live OM pull is Phase 1b. Layer 5 is the existing import path (Phase 2 wiring).

## Per-platform recommended paths

| Platform | Trino connector | Auth | Table format | Difficulty | Phase |
|----------|-----------------|------|--------------|-----------|-------|
| **AWS Glue / Athena** | `iceberg` (`iceberg.catalog.type=glue`) or `hive` (`hive.metastore=glue`) | **IRSA** (pod IAM role) | Iceberg or Hive | Low | **1 (done)** |
| **Snowflake** | Snowflake JDBC | Key-pair (vault-referenced) | native | Medium | 1b |
| **BigQuery** | BigQuery | Workload Identity / SA | native | Medium | 1b |
| **Databricks** | Delta + Unity metastore | OAuth / PAT | Delta | High (re-govern at OPA) | 2 |
| **Azure Fabric** | Delta over OneLake | Managed Identity | Delta | High | 2 |

**Build order:** Glue → Snowflake / BigQuery → Databricks / Redshift → Fabric.
Glue first because IRSA gives zero-static-key auth and Iceberg is OS-native.

## The six cross-cutting clarifications

Every source has to answer the same six questions. Phase-1 stance:

1. **Auth = cloud-native identity.** Prefer IRSA (AWS) / Workload Identity (GCP) /
   Managed Identity (Azure) so no static key is ever written into a Trino catalog
   file. Key-pair (Snowflake) and PAT (Databricks) are vault-referenced, never
   inlined. The Glue generator provably emits no `aws-access-key` line.
2. **Network reachability.** The Trino pod must be able to reach the external
   metastore + object store (VPC peering / PrivateLink / firewall). This is a
   deploy-time prerequisite, surfaced as a connection health check (Phase 1b).
3. **Govern-at-OPA vs honor-native.** Default: **re-govern at the OS's OPA** — a
   federated table is a normal Trino table, so the existing Trino→OPA row-filter +
   column-mask plugin applies on the OS's own domain. Honoring the source's native
   RLS (e.g. Snowflake row policies) is opt-in and additive, never a substitute.
4. **Identity propagation for per-user RLS.** Phase 1 governs at the OS domain
   principal (like every other governed read). True per-user pushdown to the source
   (so the source enforces the end-user's identity) needs identity federation and
   is Phase 2+.
5. **Federate vs import.** Federate for discovery, ad-hoc query, and freshness;
   import (CTAS) when you need an owned, SLA'd, medallion-versioned product,
   isolation from source load, or a stable contract. Import reuses the existing
   promote/materialize path.
6. **Cost + table format.** Federated scans bill on the source (Athena/BigQuery
   bytes-scanned; Snowflake/Databricks compute). Iceberg/Delta support predicate
   pushdown; Hive is cheapest to mount but weakest at pushdown. Import to control
   cost + freshness once a table is hot.

## Feature flag

Everything is gated behind `EXTERNAL_CONNECTORS_ENABLED` (`lib/core/config.ts`,
`config.externalConnectorsEnabled`), default **off**. The OS is open source and
LLM/providers are admin-configurable; likewise this capability is opt-in per
deployment. No UI is wired in Phase 1.

## What is real vs stubbed

**Real + unit-tested (all five providers, behind the flag):**
- A `WarehouseProvider` registry (`provider.ts`/`registry.ts`); `trinoCatalogProps(source)`
  dispatches to it. Every provider generates real Trino catalog props — **Glue** (Iceberg +
  Hive, IRSA-only, no static keys), **Snowflake** (key-pair via `${ENV:SNOWFLAKE_PRIVATE_KEY}`),
  **BigQuery** (SA-JSON file or Workload Identity), **Databricks-Delta** (`delta_lake`; Thrift/Glue
  storage mode verified, Unity mode flagged `UNVERIFIED` — Unity-as-metastore is Starburst-only
  in OSS Trino 476), **Fabric/OneLake** (`delta_lake` over ABFS/OneLake OAuth, experimental).
  Secrets are `${ENV:…}`/file references, never inlined (tests assert no key/JSON leaks).
- `externalTableFqn(catalog, schema, table)` — the `catalog.schema.table` mapping.
- `toFederatedDataset(...)` — OM/Glue descriptor → read-only `FederatedDataset`.
- Create-flow (schema/store/route/UI), the `buildImportCtas` import path, `catalogRegistration`
  (values snippet + secret-env plumbing), the MCP surface (`create_connection`/`test_connection`/
  `warehouse_registration`/`import_warehouse_table`), and the `EXTERNAL_CONNECTORS_ENABLED` flag.

**Needs a live customer source to validate (operator's step):**
- Whether each catalog actually connects + returns rows against the customer's real
  AWS/Azure/Snowflake/GCP/Databricks account (IRSA role assumption, key-pair acceptance,
  SA-JSON/Workload-Identity, PAT scope, OneLake ABFS auth).
- Databricks **Unity** REST metastore keys on the deployed Trino image (prefer the Thrift/Glue mode).
- Live OpenMetadata ingestion of external catalogs (only the connector-hint stub exists; Airflow
  ingestion is disabled here — full lineage is post-live).
