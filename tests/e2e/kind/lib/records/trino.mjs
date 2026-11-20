/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read Trino's own query log (system.runtime.queries) and Iceberg metadata tables
 * USER STORY: As AT-b/AT-c I want "the tile query ran as V" and "the approved write ran as u123"
 *             to be Trino's record of the query, with its user and its exact text.
 * ARCHITECTURE:
 *   - Trino client REST protocol: POST /v1/statement with X-Trino-User, then follow nextUri until
 *     it is gone. Docs: https://trino.io/docs/current/develop/client-protocol.html
 *   - system.runtime.queries columns: query_id, state, user, source, query, resource_group_id,
 *     created, started, end, error_type, error_code.
 *     Docs: https://trino.io/docs/current/connector/system.html
 *   - The harness authenticates as E2E_TRINO_USER. Whether that user may read the query log is
 *     Trino's (OPA's) decision; a denial is reported as a red hop.
 */
import { baseUrl, LOCAL } from '../endpoints.mjs';
import { request } from '../http.mjs';
import { HopError } from '../hop.mjs';

export async function query(sql, { user = LOCAL.trinoUser, headers = {}, hop = 'statement' } = {}) {
  const base = await baseUrl('trino');
  let { data } = await request('trino', hop, `${base}/v1/statement`, {
    method: 'POST',
    headers: { 'X-Trino-User': user, 'X-Trino-Source': 'e2e-harness', ...headers },
    body: sql,
  });
  const columns = [];
  const rows = [];
  for (;;) {
    if (data.columns && !columns.length) columns.push(...data.columns.map((c) => c.name));
    if (data.data) rows.push(...data.data);
    if (data.error) {
      throw new HopError({ component: 'trino', hop, reason: `${data.error.errorName}: ${data.error.message}`, detail: { queryId: data.id, errorType: data.error.errorType } });
    }
    if (!data.nextUri) break;
    ({ data } = await request('trino', hop, data.nextUri, { headers: { 'X-Trino-User': user } }));
  }
  return { queryId: data.id, columns, rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))) };
}

const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** Trino's own record of queries, filtered by user and/or source and/or a text fragment. */
export async function runtimeQueries({ user, source, textLike, sinceMinutes = 120 } = {}) {
  const where = [`created > current_timestamp - interval '${Number(sinceMinutes)}' minute`];
  if (user) where.push(`"user" = ${lit(user)}`);
  if (source) where.push(`source = ${lit(source)}`);
  if (textLike) where.push(`query like ${lit(`%${textLike}%`)}`);
  const sql = `select query_id, state, "user", source, query, error_type, error_code, created from system.runtime.queries where ${where.join(' and ')} order by created desc`;
  return (await query(sql, { hop: 'system.runtime.queries' })).rows;
}

/** Iceberg snapshots of a table: "<table>$snapshots". Docs: https://trino.io/docs/current/connector/iceberg.html#metadata-tables */
export async function snapshots(catalog, schema, table) {
  const sql = `select snapshot_id, committed_at, operation from ${catalog}.${schema}."${table}$snapshots" order by committed_at`;
  return (await query(sql, { hop: '$snapshots' })).rows;
}

export function requireRows(rows, what) {
  if (!rows.length) throw new HopError({ component: 'trino', hop: 'system.runtime.queries', reason: `no query matching ${what}` });
  return rows;
}
