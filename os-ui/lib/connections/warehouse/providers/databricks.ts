/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Databricks / Delta Lake provider — implemented (Phase 1b). Trino native
 * `delta_lake` connector, two realistic metastore sub-modes.
 *
 * KEY RULE — no secret material is ever emitted into the props. The Databricks PAT
 * is referenced through an env var (`${ENV:DATABRICKS_TOKEN}`) that the deploy
 * layer wires from a vault secret (`tokenSecretRef`); the token itself NEVER appears
 * in the rendered `.properties`. This mirrors Glue's "no static keys" and
 * Snowflake's `${ENV:...}` discipline.
 *
 * TRINO CONNECTOR NAME — the Trino 476 property value is `connector.name=delta_lake`
 * (UNDERSCORE), verified verbatim from
 * https://trino.io/docs/476/connector/delta-lake.html . The registry-facing
 * `trinoConnector: 'delta-lake'` field below is a human/registry label (hyphenated,
 * matching provider.ts's doc comment and the platform id) and is deliberately kept
 * distinct from the emitted `connector.name`, which uses the real underscore form.
 *
 * TWO SUB-MODES (picked from the source config):
 *   1. UNITY REST metastore (`unityCatalog` set) — HIGH RISK. Emits
 *      `hive.metastore=unity` + `unity.*` keys + the token via ${ENV:DATABRICKS_TOKEN}.
 *      *** These keys are UNVERIFIED against OSS Trino 476. *** Research against the
 *      official 476 docs found that `hive.metastore` only accepts `thrift` and `glue`
 *      in open-source Trino; `hive.metastore=unity` / `unity.host` / `unity.catalog.name`
 *      are a Starburst Enterprise commercial feature, NOT documented for OSS 476
 *      (the Thrift-over-HTTP path that reached Unity's HMS-compatible endpoint was
 *      removed in Trino 473+). They are shipped here per the connector spec but MUST
 *      be confirmed against the operator's actual image/workspace — see
 *      `liveVerificationRequired` and the UNVERIFIED comments on the keys.
 *   2. DIRECT STORAGE + Thrift/Glue metastore (`metastoreUri` and/or `storage`, no
 *      Unity) — RELIABLE DEFAULT. Every key here is CONFIRMED from the Trino 476 docs
 *      (delta-lake connector, metastores, native S3/Azure filesystem pages). Prefer
 *      this path unless Unity is a hard requirement.
 */

import {
  type DatabricksDeltaConfig,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';
import { showTablesQuery } from '../discovery-query.ts';

/** The real Trino 476 connector value — UNDERSCORE (verified from the 476 docs). */
const CONNECTOR_NAME = 'delta_lake';

/**
 * Normalize a Databricks workspace host to a bare `host[:port]` (no scheme, no path).
 * Accepts either a bare host (`dbc-xxxx.cloud.databricks.com`) or a full URL
 * (`https://dbc-xxxx.cloud.databricks.com`). Pure + total: throws on empty/malformed
 * input rather than folding garbage into the emitted props.
 */
function normalizeHost(host: string): string {
  let raw = (host ?? '').trim();
  if (!raw) {
    throw new WarehouseError('databricks-delta: missing workspace host');
  }
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // strip scheme
  raw = raw.split('/')[0]; // strip path/query
  if (!/^[a-z0-9][a-z0-9.:-]*$/i.test(raw)) {
    throw new WarehouseError(`databricks-delta: invalid workspace host '${host}'`);
  }
  return raw;
}

/**
 * Emit the native object-storage filesystem keys for the Delta table data, chosen
 * from the `storage` root scheme. CONFIRMED from the Trino 476 object-storage docs.
 *   - `s3://` / `s3a://`      → native S3 (`fs.native-s3.enabled`, `s3.region` if known)
 *   - `abfs://` / `abfss://`  → native Azure ADLS (`fs.native-azure.enabled`)
 * We never emit static storage credentials — the pod's cloud identity (IRSA /
 * Managed Identity / Workload Identity) supplies them via the default chain.
 */
function applyStorageFs(props: TrinoCatalogProps, storage: string | undefined): void {
  if (!storage) return;
  const s = storage.trim().toLowerCase();
  if (s.startsWith('s3://') || s.startsWith('s3a://')) {
    props['fs.native-s3.enabled'] = 'true';
  } else if (s.startsWith('abfs://') || s.startsWith('abfss://')) {
    props['fs.native-azure.enabled'] = 'true';
  }
  // Any other scheme (gs://, dbfs:/, unknown) is left to the operator's image
  // defaults — we do not guess a filesystem we cannot verify.
}

/**
 * UNITY REST metastore mode. HIGH RISK — see the file header. Emits the Unity keys
 * plus the token via env. Every Unity key carries an UNVERIFIED marker because OSS
 * Trino 476 does not document `hive.metastore=unity`.
 */
function unityProps(cfg: DatabricksDeltaConfig): TrinoCatalogProps {
  const host = normalizeHost(cfg.host);
  const props: TrinoCatalogProps = {
    'connector.name': CONNECTOR_NAME,
    // UNVERIFIED(trino-476): confirm exact key names against a live Unity endpoint —
    // `hive.metastore=unity` and the `unity.*` keys are NOT in the OSS Trino 476 docs
    // (thrift|glue only); this path targets Starburst-style Unity support.
    'hive.metastore': 'unity',
    'unity.host': host,
    'unity.catalog.name': cfg.unityCatalog as string,
    // Token is referenced via env — the PAT is NEVER inlined into props.
    'unity.token': '${ENV:DATABRICKS_TOKEN}',
  };
  if (cfg.httpPath) props['unity.http-path'] = cfg.httpPath; // UNVERIFIED(trino-476)
  applyStorageFs(props, cfg.storage);
  return props;
}

/**
 * DIRECT STORAGE + Thrift/Glue metastore mode. RELIABLE DEFAULT — every key is
 * CONFIRMED from the Trino 476 docs. Picks `thrift` when a `metastoreUri` is given,
 * otherwise `glue` (metastore lives in AWS Glue; storage supplies the data).
 */
function storageProps(cfg: DatabricksDeltaConfig): TrinoCatalogProps {
  const props: TrinoCatalogProps = { 'connector.name': CONNECTOR_NAME };

  if (cfg.metastoreUri) {
    // Thrift Hive Metastore — CONFIRMED (trino-476 delta-lake + metastores docs).
    const uri = cfg.metastoreUri.trim();
    if (!/^thrift:\/\/[^\s]+$/i.test(uri)) {
      throw new WarehouseError(
        `databricks-delta: metastoreUri must be a thrift:// URI, got '${cfg.metastoreUri}'`,
      );
    }
    props['hive.metastore'] = 'thrift';
    props['hive.metastore.uri'] = uri;
  } else {
    // No Thrift URI and no Unity → default to Glue as the metadata source.
    // CONFIRMED (trino-476): hive.metastore=glue. Region resolves from the pod's
    // AWS config/identity; we do not fabricate a region we were not given.
    props['hive.metastore'] = 'glue';
  }

  applyStorageFs(props, cfg.storage);
  return props;
}

/**
 * Databricks / Delta Lake → Trino native `delta_lake` connector. Validates required
 * config and dispatches to the Unity or the storage/Thrift-Glue sub-mode.
 */
function databricksProps(cfg: DatabricksDeltaConfig): TrinoCatalogProps {
  if (!cfg.host || !cfg.host.trim()) {
    throw new WarehouseError('databricks-delta: missing workspace host');
  }

  const unity = cfg.unityCatalog && cfg.unityCatalog.trim();
  if (unity) {
    if (!cfg.tokenSecretRef || !cfg.tokenSecretRef.trim()) {
      // Unity REST auth needs the PAT; without a vault ref there is nothing to mount
      // into ${ENV:DATABRICKS_TOKEN}, so the catalog would fail to authenticate.
      throw new WarehouseError(
        'databricks-delta: unityCatalog requires a tokenSecretRef (PAT) for Unity auth',
      );
    }
    return unityProps(cfg);
  }

  // Non-Unity: need SOME metastore/storage config to point the connector at.
  if (!cfg.metastoreUri && !cfg.storage) {
    throw new WarehouseError(
      'databricks-delta: provide unityCatalog, or a metastoreUri and/or storage root',
    );
  }
  return storageProps(cfg);
}

export const databricksProvider: WarehouseProvider = {
  platform: 'databricks-delta',
  label: 'Databricks / Delta Lake',
  // Registry/human label (hyphenated). The EMITTED Trino prop is `delta_lake`
  // (underscore) — see CONNECTOR_NAME and the file header.
  trinoConnector: 'delta-lake',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source) => databricksProps(source as DatabricksDeltaConfig),
  discoverTables: (source, schema) => showTablesQuery(source, schema),
  credentialFields: [
    {
      key: 'host',
      label: 'Workspace host',
      kind: 'text',
      required: true,
      help: 'Databricks workspace host or URL, e.g. https://dbc-xxxx.cloud.databricks.com.',
    },
    {
      key: 'httpPath',
      label: 'SQL warehouse HTTP path',
      kind: 'text',
      required: false,
      help: 'HTTP path for the SQL-warehouse variant, e.g. /sql/1.0/warehouses/abc123. Optional.',
    },
    {
      key: 'unityCatalog',
      label: 'Unity Catalog name',
      kind: 'text',
      required: false,
      help: 'Unity Catalog the Delta tables live under. Set this to use the Unity metastore mode (requires a token).',
    },
    {
      key: 'metastoreUri',
      label: 'Thrift metastore URI',
      kind: 'text',
      required: false,
      help: 'thrift://host:9083 for a Hive Metastore. Use instead of Unity for the reliable, fully-verified storage mode.',
    },
    {
      // The PAT is collected here but NEVER lands in the catalog props; it is stored
      // as a vault secret and mounted via ${ENV:DATABRICKS_TOKEN}.
      key: 'databricks-token',
      label: 'Access token (PAT)',
      kind: 'password',
      required: true,
      help: 'Databricks personal access token / OAuth token. Required for Unity mode. Stored as a secret; never inlined into props.',
    },
  ],
  // The PAT is the only secret; it is mounted as DATABRICKS_TOKEN and referenced by
  // ${ENV:DATABRICKS_TOKEN} in the rendered Unity-mode props.
  secretMaterial: {
    secretKeys: ['databricks-token'],
    envVars: ['DATABRICKS_TOKEN'],
  },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'DeltaLake',
    configKeys: ['metastoreConnection', 'configSource', 'connection', 'databaseFilterPattern'],
  },
  // Rendering is verified purely against the Trino 476 docs for the storage/Thrift/Glue
  // path. Unity mode and all live auth need a real Databricks workspace, which cannot
  // be created here.
  liveVerificationRequired: [
    'Unity Catalog REST auth against a live Databricks workspace (PAT/OAuth token accepted)',
    'PAT scope: whether the token has the metastore + external-location read grants Unity requires',
    'ADLS/S3 storage-credential vending: whether Unity vends short-lived storage creds or the pod identity must read the Delta files directly',
    'CRITICAL: whether the trino-476 image even supports `hive.metastore=unity` + the `unity.*` key names — OSS Trino 476 documents ONLY thrift|glue; Unity-as-metastore is a Starburst-style feature, so these keys are UNVERIFIED and must be checked against THIS operator\'s image and workspace (the second-riskiest connector)',
  ],
};
