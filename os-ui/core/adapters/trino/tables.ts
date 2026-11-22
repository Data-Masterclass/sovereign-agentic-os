/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Iceberg tables that exist in Trino, read from Trino (ownership rule)
 * USER STORY: As a platform engineer I create a table directly in Trino and the OS can see it.
 * ARCHITECTURE: `iceberg.information_schema.tables` (Trino's standard information schema) through
 *   the governed query the caller passes in; OPA decides which schemas that caller can list. An
 *   unreachable Trino is `ok:false`, never an empty list.
 */
import type { Fetched } from '../_contract';

export const TABLES_SQL = "SELECT table_schema, table_name FROM iceberg.information_schema.tables WHERE table_schema <> 'information_schema' ORDER BY table_schema, table_name";

export type PhysicalTable = { schema: string; table: string };

export async function readIcebergTables(query: (sql: string) => Promise<{ rows: unknown[][] }>): Promise<Fetched<PhysicalTable[]>> {
  const at = new Date().toISOString();
  try {
    const r = await query(TABLES_SQL);
    return { ok: true, value: r.rows.map((x) => ({ schema: String(x[0]), table: String(x[1]) })), at };
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: e instanceof Error ? e.message : String(e), at };
  }
}
