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
import { isValidCatalogName, WarehouseError, type WarehousePlatform } from './types.ts';
import type { ImportColumn, TypeRule } from './provider.ts';
import { providerFor } from './registry.ts';

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

// -------------------------------------------- engine-specific typed import (opt-in) --

/** One resolved column in a typed import: its select expression + any honest caveat. */
export type ImportColumnPlan = { name: string; expr: string; note?: string };

/** The result of planning a typed CTAS: the select list + the lossy-cast warnings. */
export type TypedImportPlan = { sql: string; columns: ImportColumnPlan[]; warnings: string[] };

/** A source column name is a legal unquoted identifier we can fold into SELECT. */
function isSafeColumn(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Resolve ONE column against a provider's ordered `importTypeRules`. The first rule
 * whose `match` hits the (lower-cased) declared type wins; `castTo` becomes a
 * `CAST(<col> AS <type>)` (with the rule's honest note attached), and a rule with no
 * `castTo` passes the column through unchanged (a note-only advisory). No rule ⇒ the
 * bare column, no cast. Pure + total.
 */
export function planImportColumn(col: ImportColumn, rules: TypeRule[] | undefined): ImportColumnPlan {
  if (!isSafeColumn(col.name)) {
    throw new WarehouseError(`import: unsafe source column name '${col.name}'`);
  }
  const t = (col.type ?? '').trim().toLowerCase();
  for (const rule of rules ?? []) {
    if (rule.match.test(t)) {
      if (rule.castTo) {
        return { name: col.name, expr: `CAST(${col.name} AS ${rule.castTo}) AS ${col.name}`, note: rule.note };
      }
      return { name: col.name, expr: col.name, note: rule.note };
    }
  }
  return { name: col.name, expr: col.name };
}

/**
 * Build an ENGINE-SPECIFIC, type-honest CTAS when the caller has the source schema in
 * hand (from discovery). Unlike `buildImportCtas`'s blanket `SELECT *`, this consults
 * the platform provider's `importTypeRules` to CAST source types that have no faithful
 * Iceberg equivalent (Snowflake VARIANT → json, BigQuery STRUCT/ARRAY → json/varchar,
 * geography → varchar, …) and collects the lossy-cast notes as `warnings`.
 *
 * Falls back to `buildImportCtas` (plain `SELECT *`) when no columns are supplied — so
 * this is purely additive over the existing path. Pure + total; every identifier is
 * validated with the same rule the FQN uses.
 */
export function buildTypedImportCtas(
  target: ImportTarget,
  source: ImportSource,
  platform: WarehousePlatform,
  columns: ImportColumn[],
): TypedImportPlan {
  if (!columns || columns.length === 0) {
    return { sql: buildImportCtas(target, source), columns: [], warnings: [] };
  }
  for (const [label, part] of [
    ['domain', target.domain],
    ['name', target.name],
  ] as const) {
    if (!part || !isValidCatalogName(part)) {
      throw new WarehouseError(`import target: invalid ${label} '${part ?? ''}'`);
    }
  }
  const srcFqn = externalTableFqn(source.catalog, source.schema, source.table);
  const dstFqn = `iceberg.${target.domain}.${target.name}`;
  const rules = providerFor(platform).importTypeRules;
  const plans = columns.map((c) => planImportColumn(c, rules));
  const selectList = plans.map((p) => p.expr).join(', ');
  const warnings = plans
    .filter((p) => p.note)
    .map((p) => `${p.name}: ${p.note}`);
  return {
    sql: `CREATE TABLE ${dstFqn} AS SELECT ${selectList} FROM ${srcFqn}`,
    columns: plans,
    warnings,
  };
}
