/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the pure, client-safe TYPES (Phase 1).
 *
 * A "warehouse catalog" connection federates an EXTERNAL lakehouse into the OS
 * through the SAME central governed Trino: each external source becomes ONE Trino
 * CATALOG. This module holds only types + light constants (no secrets, no server
 * imports), so both the client editor and the server routes can import it.
 *
 * The five-layer pattern (see docs/external-warehouse-connectors.md):
 *   1. Connection        — this typed config + a vault ref (creds are cloud-native
 *                          identity where possible; NO static keys in Trino props).
 *   2. Trino catalog     — `trinoCatalogProps(source)` renders `<name>.properties`.
 *   3. OM ingest         — the external catalog's tables mirror into OpenMetadata.
 *   4. Federated dataset — a read-only registry entry (kind='federated') pointing
 *                          at `catalog.schema.table`.
 *   5. Import as product — CTAS materializes it into the OS Iceberg lakehouse
 *                          (reuses the existing promote/materialize path).
 *
 * Phase 1 implements Glue end-to-end (as PURE prop generation); the other
 * platforms are typed stubs so the shape is established.
 */

/**
 * The external warehouse platforms the OS can federate. Glue is the Phase 1
 * target; the rest are scaffolded as config templates only (see catalog-props).
 */
export type WarehousePlatform =
  | 'glue'
  | 'snowflake'
  | 'bigquery'
  | 'databricks-delta'
  | 'fabric';

export const WAREHOUSE_PLATFORMS: WarehousePlatform[] = [
  'glue',
  'snowflake',
  'bigquery',
  'databricks-delta',
  'fabric',
];

/**
 * The Trino connector that backs a Glue-catalogued source. A Glue database can
 * hold Hive-format OR Iceberg tables; the operator picks which connector to point
 * at the shared Glue metastore. Defaults to `iceberg` (the OS-native format).
 */
export type GlueTableFormat = 'hive' | 'iceberg';

/**
 * A typed external-warehouse connection config — the INPUT to the pure Trino
 * catalog-props generator. This is the platform-specific block; the surrounding
 * Connection record (owner/domain/visibility/secretRef) is modelled by the
 * existing Connections schema. NO SECRET VALUES live here — auth is cloud-native
 * identity (IRSA / Workload Identity / Managed Identity) or a vault-referenced
 * key-pair, never a static key baked into these props.
 */
export type WarehouseSource = {
  /** The Trino catalog name this source is mounted as (e.g. `glue_sales`). Must be
   *  a legal catalog identifier — see `isValidCatalogName`. */
  catalog: string;
  platform: WarehousePlatform;
} & WarehousePlatformConfig;

/** The per-platform config union (discriminated by `platform`). */
export type WarehousePlatformConfig =
  | GlueConfig
  | SnowflakeConfig
  | BigQueryConfig
  | DatabricksDeltaConfig
  | FabricConfig;

/** AWS Glue / Athena via the Trino Hive/Iceberg connector (`hive.metastore=glue`). */
export type GlueConfig = {
  platform: 'glue';
  /** AWS region the Glue Data Catalog lives in (e.g. `eu-central-1`). */
  region: string;
  /** Hive- or Iceberg-format tables (default 'iceberg'). Chooses the connector. */
  format?: GlueTableFormat;
  /** Optional Glue Data Catalog id (AWS account id) for cross-account catalogs. */
  glueCatalogId?: string;
  /** Optional default S3 location for Hive-format writes (read-only federation
   *  never writes, but Trino requires it for some operations). */
  defaultWarehouseDir?: string;
};

/** Snowflake via the Trino Snowflake JDBC connector (key-pair auth). Phase 1b. */
export type SnowflakeConfig = {
  platform: 'snowflake';
  /** Snowflake account URL, e.g. `https://ORG-ACCOUNT.snowflakecomputing.com`. */
  accountUrl: string;
  database: string;
  warehouse: string;
  /** Vault ref name for the key-pair private key (NEVER inlined). */
  privateKeySecretRef?: string;
};

/** BigQuery via the Trino BigQuery connector (Workload Identity / SA). Phase 1b. */
export type BigQueryConfig = {
  platform: 'bigquery';
  projectId: string;
};

/** Databricks Delta via the Trino Delta connector + Unity metastore. Phase 1b. */
export type DatabricksDeltaConfig = {
  platform: 'databricks-delta';
  /** Databricks workspace host, e.g. `https://dbc-xxxx.cloud.databricks.com`. */
  host: string;
  /** Unity Catalog metastore endpoint. */
  metastoreUri?: string;
};

/** Azure Fabric — Delta over OneLake. Phase 1b. */
export type FabricConfig = {
  platform: 'fabric';
  /** OneLake ABFS endpoint for the workspace. */
  oneLakeUri: string;
};

/**
 * The rendered Trino catalog `.properties` map: the exact key/value pairs written
 * to `/etc/trino/catalog/<name>.properties`. Pure data — the deploy layer turns
 * this into a file. Values reference env vars (`${ENV:...}`) for anything that
 * would otherwise be a secret; this module never emits a secret value.
 */
export type TrinoCatalogProps = Record<string, string>;

/** A legal Trino catalog / schema / table identifier (unquoted): [a-z0-9_]. */
export function isValidCatalogName(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(name);
}

/** Raised when a warehouse source is malformed or targets an un-built platform. */
export class WarehouseError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WarehouseError';
    this.status = status;
  }
}
