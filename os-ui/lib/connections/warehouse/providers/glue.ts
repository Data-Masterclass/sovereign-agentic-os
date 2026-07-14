/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * AWS Glue provider — FULLY implemented (Phase 1).
 *
 * A Glue database can hold Hive-format OR Iceberg tables; the operator picks which
 * Trino connector points at the shared Glue metastore (defaults to `iceberg`, the
 * OS-native format).
 *
 * KEY RULE — no static credentials are ever emitted. Glue authenticates via the
 * pod's IAM role (IRSA): the AWS SDK default credential chain resolves the role
 * automatically, so there are NO `aws-access-key` / `aws-secret-key` lines in the
 * generated props. `secretMaterial` is therefore EMPTY by design.
 */

import {
  type GlueConfig,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';
import { showTablesQuery } from '../discovery-query.ts';

/**
 * AWS Glue / Athena → Trino Hive OR Iceberg connector against the Glue metastore.
 *
 * Auth is IRSA: the Trino pod's ServiceAccount is annotated with an IAM role, so
 * the AWS SDK's default credential chain resolves the role automatically. We emit
 * NO static keys — only the region and the `hive.metastore=glue` wiring. S3 access
 * uses the native S3 filesystem, likewise via the pod's role.
 *
 * Moved VERBATIM from the old `catalog-props.ts` switch — behavior is byte-identical.
 */
function glueProps(cfg: GlueConfig & { catalog: string }): TrinoCatalogProps {
  if (!cfg.region || !/^[a-z0-9-]+$/.test(cfg.region)) {
    throw new WarehouseError(`glue: invalid or missing AWS region '${cfg.region ?? ''}'`);
  }
  const format = cfg.format ?? 'iceberg';
  const props: TrinoCatalogProps = {
    // Iceberg-format Glue tables use the `iceberg` connector with the Glue catalog
    // type; Hive-format tables use the `hive` connector with `hive.metastore=glue`.
    'connector.name': format === 'iceberg' ? 'iceberg' : 'hive',
  };

  if (format === 'iceberg') {
    props['iceberg.catalog.type'] = 'glue';
    props['hive.metastore.glue.region'] = cfg.region;
    if (cfg.glueCatalogId) props['hive.metastore.glue.catalogid'] = cfg.glueCatalogId;
  } else {
    props['hive.metastore'] = 'glue';
    props['hive.metastore.glue.region'] = cfg.region;
    if (cfg.glueCatalogId) props['hive.metastore.glue.catalogid'] = cfg.glueCatalogId;
    if (cfg.defaultWarehouseDir) {
      props['hive.metastore.glue.default-warehouse-dir'] = cfg.defaultWarehouseDir;
    }
  }

  // Native S3 filesystem; region only. Credentials come from the pod's IAM role
  // (IRSA) via the AWS default credential chain — NEVER emitted here.
  props['fs.native-s3.enabled'] = 'true';
  props['s3.region'] = cfg.region;

  return props;
}

export const glueProvider: WarehouseProvider = {
  platform: 'glue',
  label: 'AWS Glue / Athena',
  // Glue backs BOTH the iceberg and hive connectors; iceberg is the OS-native default.
  trinoConnector: 'iceberg',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source) => glueProps(source as GlueConfig & { catalog: string }),
  discoverTables: (source, schema) => showTablesQuery(source, schema),
  // IRSA only — the pod's IAM role is the credential. There are NO collected secrets.
  credentialFields: [
    {
      key: 'region',
      label: 'AWS region',
      kind: 'text',
      required: true,
      help: 'Region the Glue Data Catalog lives in, e.g. eu-central-1.',
    },
    {
      key: 'glueCatalogId',
      label: 'Glue catalog id (cross-account)',
      kind: 'text',
      required: false,
      help: 'AWS account id for a cross-account Glue Data Catalog. Leave blank for the pod account.',
    },
  ],
  // EMPTY by design: IRSA supplies credentials via the pod's IAM role — provably no
  // static keys, which the "IRSA only" test asserts against the rendered props.
  secretMaterial: { secretKeys: [], envVars: [] },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'Glue',
    configKeys: ['awsRegion', 'awsConfig', 'databaseFilterPattern'],
  },
  // Region + IRSA rendering are verified purely; the actual Glue reachability and
  // IAM-role assumption can only be confirmed against a real AWS account.
  liveVerificationRequired: [
    'Glue Data Catalog reachability from the Trino pod (real AWS account)',
    'IRSA IAM-role assumption + S3 read permissions on the table data',
  ],
};
