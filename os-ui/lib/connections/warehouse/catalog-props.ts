/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the PURE Trino catalog-props generator (Phase 1).
 *
 * Given a typed {@link WarehouseSource}, `trinoCatalogProps` returns the Trino
 * catalog `.properties` map that mounts the external source as ONE governed Trino
 * catalog. The deploy layer (Phase 1b) turns this map into a file at
 * `/etc/trino/catalog/<catalog>.properties`; this module is pure + fully tested.
 *
 * GLUE is implemented end-to-end. The other platforms are typed stubs that throw
 * `WarehouseError` with a clear "not yet implemented in Phase 1" message OR return
 * a documented TEMPLATE (see each helper) so the shape is established without
 * pretending to be a validated live path.
 *
 * KEY RULE: no static credentials are ever emitted. Glue authenticates via the
 * pod's IAM role (IRSA) — the AWS SDK default credential chain — so there are NO
 * `aws-access-key` / `aws-secret-key` lines in the generated props.
 */

import {
  type WarehouseSource,
  type GlueConfig,
  type TrinoCatalogProps,
  isValidCatalogName,
  WarehouseError,
} from './types.ts';

/**
 * Render the Trino catalog `.properties` for an external warehouse source.
 * Pure: same input → same output; no I/O, no secrets.
 */
export function trinoCatalogProps(source: WarehouseSource): TrinoCatalogProps {
  if (!isValidCatalogName(source.catalog)) {
    throw new WarehouseError(
      `invalid Trino catalog name '${source.catalog}' (must match [a-z_][a-z0-9_]*)`,
    );
  }
  switch (source.platform) {
    case 'glue':
      return glueProps(source);
    case 'snowflake':
    case 'bigquery':
    case 'databricks-delta':
    case 'fabric':
      throw new WarehouseError(
        `warehouse platform '${source.platform}' is not yet implemented in Phase 1 ` +
          `(Glue only); config template established, live path is Phase 1b`,
        501,
      );
    default: {
      // Exhaustiveness guard — a new platform must add a case above.
      const never: never = source;
      throw new WarehouseError(`unknown warehouse platform: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * AWS Glue / Athena → Trino Hive OR Iceberg connector against the Glue metastore.
 *
 * Auth is IRSA: the Trino pod's ServiceAccount is annotated with an IAM role, so
 * the AWS SDK's default credential chain resolves the role automatically. We emit
 * NO static keys — only the region and the `hive.metastore=glue` wiring. S3 access
 * uses the native S3 filesystem, likewise via the pod's role.
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

/**
 * Map an EXTERNAL fully-qualified table name to its OS-facing Trino FQN.
 *
 * An external source exposes tables as `<schema>.<table>` within its Glue/other
 * catalog. Once mounted as the Trino catalog `<catalog>`, the OS addresses it as
 * `<catalog>.<schema>.<table>` — the SAME three-part shape the governed query path
 * and OPA already understand. This is the discovery/query on-ramp; it does NOT
 * copy data (that's `import as product`).
 *
 * Pure + total: throws `WarehouseError` on a malformed input rather than emitting
 * a nonsense FQN.
 */
export function externalTableFqn(
  catalog: string,
  schema: string,
  table: string,
): string {
  for (const [label, part] of [
    ['catalog', catalog],
    ['schema', schema],
    ['table', table],
  ] as const) {
    if (!part || !isValidCatalogName(part)) {
      throw new WarehouseError(`external FQN: invalid ${label} segment '${part ?? ''}'`);
    }
  }
  return `${catalog}.${schema}.${table}`;
}
