/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — IMPORT AS PRODUCT (layer 5, Phase 2 wiring).
 *
 * Federation mounts an external source as a governed Trino catalog and queries it
 * LIVE (no copy). "Import" is the other mode: materialize ONE external table into
 * the OS's own Iceberg lakehouse so it becomes an owned, medallion-versioned data
 * product. That is a plain CTAS — the SAME governed write path promote/materialize
 * already uses (`executeRun` → query-tool → Trino, run AS the caller under OPA). We
 * reuse it verbatim rather than inventing a second write door.
 *
 * `buildImportCtas` is PURE (SQL string only) so it is fully unit-tested without a
 * cluster; `importFederatedTable` is the thin server wrapper that runs it.
 */

import { externalTableFqn } from './catalog-props.ts';
import { isValidCatalogName, WarehouseError } from './types.ts';

/** The target the external table materializes into: `iceberg.<domain>.<name>`. */
export type ImportTarget = { domain: string; name: string };

/** The source table to import, addressed by its external Trino FQN parts. */
export type ImportSource = { catalog: string; schema: string; table: string };

/**
 * Build the governed CTAS that materializes an external federated table into the OS
 * Iceberg lakehouse: `CREATE TABLE iceberg.<domain>.<name> AS SELECT * FROM
 * <catalog>.<schema>.<table>`. Every identifier is validated with the SAME rule the
 * federation FQN uses ([a-z_][a-z0-9_]*), so nothing unquoted-unsafe reaches Trino.
 *
 * Pure + total: throws `WarehouseError` on any malformed identifier rather than
 * emitting a nonsense (or injectable) statement. The query-tool re-validates the
 * statement allowlist + the target-schema/role gate before Trino sees it.
 */
export function buildImportCtas(target: ImportTarget, source: ImportSource): string {
  for (const [label, part] of [
    ['domain', target.domain],
    ['name', target.name],
  ] as const) {
    if (!part || !isValidCatalogName(part)) {
      throw new WarehouseError(`import target: invalid ${label} '${part ?? ''}'`);
    }
  }
  // externalTableFqn validates catalog/schema/table with the same rule.
  const srcFqn = externalTableFqn(source.catalog, source.schema, source.table);
  const dstFqn = `iceberg.${target.domain}.${target.name}`;
  return `CREATE TABLE ${dstFqn} AS SELECT * FROM ${srcFqn}`;
}
