/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — the shared, PURE discovery-query builder.
 *
 * Discovery federates through the SAME central governed Trino as everything else:
 * a source's schemas come from `SHOW SCHEMAS FROM <catalog>` (the provider's
 * `testProbe`) and a schema's tables from `SHOW TABLES FROM <catalog>.<schema>`.
 * This module renders that second query with the SAME discipline as the probe:
 * it is pure (no I/O, no secrets) and it VALIDATES the schema identifier so a
 * malformed schema can never fold unquoted user input into SQL. Every SQL-probe
 * provider reuses this one builder so the guard lives in exactly one place.
 */

import { type WarehouseSource, isValidCatalogName, WarehouseError } from './types.ts';

/**
 * Render `SHOW TABLES FROM <catalog>.<schema>` for a source. Both identifiers are
 * validated against the legal unquoted-identifier rule (`[a-z_][a-z0-9_]*`) — the
 * catalog by construction (it was validated at create time) and the schema here —
 * so the returned string is total + injection-safe. Throws `WarehouseError` on a
 * malformed schema rather than emitting an unsafe query.
 */
export function showTablesQuery(source: WarehouseSource, schema: string): string {
  const s = (schema ?? '').trim();
  if (!s || !isValidCatalogName(s)) {
    throw new WarehouseError(`invalid schema identifier '${schema ?? ''}' (expected [a-z_][a-z0-9_]*)`);
  }
  if (!isValidCatalogName(source.catalog)) {
    throw new WarehouseError(`invalid catalog identifier '${source.catalog}'`);
  }
  return `SHOW TABLES FROM ${source.catalog}.${s}`;
}
