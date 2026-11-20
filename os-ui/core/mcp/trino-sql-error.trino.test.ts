/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Real-Trino proof of the typed `sql_error` and its Trino-dialect hints
 * USER STORY: As an agent whose SQL Trino rejected I want a hint that names Trino's own function,
 *             so that I can fix the query instead of giving up.
 * ARCHITECTURE:
 *   - Runs on the lakehouse harness (tests/lakehouse) through its own client (lib.mjs).
 *   - Feeds Trino's real error class through `structuredError` (./server.ts).
 */
/**
 * REAL TRINO: a Trino SQL error reaches an agent as a typed `sql_error` with a Trino-dialect hint,
 * and every function a hint recommends really runs on the pinned Trino (476, tests/lakehouse).
 *
 * The error each statement produces is Trino's own (`errorType`/`errorName` from the client
 * protocol). It is rendered the way the query-tool passes it on: the trino-python-client's
 * `TrinoQueryError.__repr__`, `TrinoUserError(type=…, name=…, message="…", query_id=…)` — the
 * exact string seen on the live MCP. Runs when LH_TRINO_URL is set; skipped otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore -- the harness client is plain JS (tests/lakehouse/lib.mjs), no type declarations
import { run } from '../../../tests/lakehouse/lib.mjs';

type TrinoFailure = Error & { errorName?: string; errorType?: string; trinoMessage?: string };
const trino = (sql: string, user: string): Promise<{ rows: unknown[][] }> => run(sql, { user, source: 'os-ui-it' });
const skip = process.env.LH_TRINO_URL ? false : 'LH_TRINO_URL not set (start tests/lakehouse/up.sh)';
const { structuredError } = await import('./server.ts');
const USER = 'it-sql-agent';

/** Run `sql`, expect Trino to fail it, and return the error as the query-tool forwards it. */
async function failure(sql: string): Promise<{ name: string; asForwarded: Error }> {
  try {
    await trino(sql, USER);
  } catch (e) {
    const f = e as TrinoFailure;
    const message = f.trinoMessage;
    return { name: f.errorName!, asForwarded: new Error(`TrinoUserError(type=${f.errorType}, name=${f.errorName}, message="${message}", query_id=x)`) };
  }
  throw new Error(`Trino accepted: ${sql}`);
}

const CASES: [string, string, RegExp][] = [
  ["SELECT string_agg(x, ', ') FROM (VALUES 'a', 'b') t(x)", 'FUNCTION_NOT_FOUND', /listagg\(x, ', '\) WITHIN GROUP \(ORDER BY x\)/],
  ["SELECT string_agg(DISTINCT x, ', ') FROM (VALUES 'a', 'b') t(x)", 'FUNCTION_NOT_AGGREGATE', /array_join\(array_agg\(DISTINCT x\), ', '\)/],
  ['SELECT TOP 5 x FROM (VALUES 1) t(x)', 'SYNTAX_ERROR', /LIMIT n/],
  ['SELECT nope FROM (VALUES 1) t(x)', 'COLUMN_NOT_FOUND', /DESCRIBE/],
  ['SELECT 1 FROM iceberg.information_schema.no_such_table', 'TABLE_NOT_FOUND', /queryable\.fqn/],
  ['SELECT 1 FROM iceberg.no_such_schema_it.t', 'SCHEMA_NOT_FOUND', /queryable\.fqn/],
];

for (const [sql, name, hint] of CASES) {
  test(`${name} from real Trino → sql_error with a Trino-dialect hint`, { skip }, async () => {
    const f = await failure(sql);
    assert.equal(f.name, name, 'Trino reports this error class');
    const e = structuredError(f.asForwarded);
    assert.equal(e.code, 'sql_error');
    assert.match(e.hint, /Trino/);
    assert.match(e.hint, hint);
    assert.equal(e.reason, f.asForwarded.message, 'Trino’s own message is passed through unchanged');
  });
}

test('every function a hint recommends runs on the pinned Trino', { skip }, async () => {
  const src = "(VALUES 'b', 'a', 'b') t(x)";
  assert.deepEqual((await trino(`SELECT listagg(x, ', ') WITHIN GROUP (ORDER BY x) FROM ${src}`, USER)).rows, [['a, b, b']]);
  const distinct = (await trino(`SELECT array_join(array_agg(DISTINCT x), ', ') FROM ${src}`, USER)).rows[0][0] as string;
  assert.deepEqual(distinct.split(', ').sort(), ['a', 'b']);
  assert.ok((await trino('SHOW FUNCTIONS', USER)).rows.length > 100);
});

test('NEGATIVE TWIN: an access denial is not a dialect problem and is not labelled sql_error', { skip }, async () => {
  const e = structuredError(new Error('TrinoUserError(type=USER_ERROR, name=PERMISSION_DENIED, message="Access Denied: x", query_id=x)'));
  assert.notEqual(e.code, 'sql_error');
  const internal = structuredError(new Error('TrinoQueryError(type=INTERNAL_ERROR, name=GENERIC_INTERNAL_ERROR, message="x", query_id=x)'));
  assert.notEqual(internal.code, 'sql_error');
});
