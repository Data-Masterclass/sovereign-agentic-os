/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The catalogs Trino serves, read from Trino (ownership rule)
 * USER STORY: As a platform engineer I add or remove a catalog in the chart and the OS shows it as a
 *             data source on its next read, with no OS change and no redeploy.
 * ARCHITECTURE: `system.metadata.catalogs` is Trino's documented table of its catalogs
 *   (https://trino.io/docs/current/connector/system.html). The query runs through the governed
 *   path the caller passes in (OPA decides what that caller may see). An unreadable Trino is
 *   `ok:false`, never an empty list. Trino's own `system` catalog is left out.
 */
import type { Fetched } from '../_contract';

export const CATALOGS_SQL = 'SELECT catalog_name FROM system.metadata.catalogs ORDER BY catalog_name';

export async function readTrinoCatalogs(query: (sql: string) => Promise<{ rows: unknown[][] }>): Promise<Fetched<string[]>> {
  const at = new Date().toISOString();
  try {
    const r = await query(CATALOGS_SQL);
    const names = r.rows.map((x) => String(x[0])).filter((n) => n && n !== 'system');
    return { ok: true, value: [...new Set(names)].sort(), at };
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: e instanceof Error ? e.message : String(e), at };
  }
}
