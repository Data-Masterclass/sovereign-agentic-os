/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A typed `sql_error` for Trino's own SQL errors, with a hint in Trino's dialect
 * USER STORY: As an agent whose query failed on a dialect mistake I want to be told the engine is
 *             Trino and what the Trino form is, so that I fix the SQL instead of giving up.
 * ARCHITECTURE:
 *   - Reads the error NAME Trino reports. The query-tool passes the Trino client's error through
 *     verbatim (`TrinoUserError(type=USER_ERROR, name=FUNCTION_NOT_FOUND, message=…)`), so the
 *     name is matched there; nothing is re-parsed from the SQL and the user's SQL is never changed.
 *   - Error names: https://trino.io/docs/476/develop/error-codes.html (StandardErrorCode).
 *   - Functions named in hints exist in Trino 476: listagg, array_agg, array_join
 *     (https://trino.io/docs/476/functions/aggregate.html, …/functions/array.html). Proven
 *     against the real engine by tests/lakehouse/sql-error.int.test.mjs.
 *   - Called by `structuredError` in ./server.ts.
 */

export const SQL_ERROR = 'sql_error';

const STRING_AGG =
  "For string aggregation use listagg(x, ', ') WITHIN GROUP (ORDER BY x), or array_join(array_agg(DISTINCT x), ', ') for distinct values.";

/** The hint per Trino USER_ERROR name. Short, and true of Trino 476. */
const HINTS: Record<string, string> = {
  FUNCTION_NOT_FOUND: `The SQL runs on Trino, not PostgreSQL or T-SQL, and Trino has no function by this name. ${STRING_AGG} Run SHOW FUNCTIONS to list what exists.`,
  FUNCTION_NOT_AGGREGATE: `The SQL runs on Trino: DISTINCT and WITHIN GROUP work only inside a Trino aggregate function. ${STRING_AGG}`,
  SYNTAX_ERROR:
    'The SQL runs on Trino: quote identifiers with double quotes and strings with single quotes, and use LIMIT n (not TOP n). Fix the part of the statement the line:column in `reason` points to.',
  COLUMN_NOT_FOUND:
    'The SQL runs on Trino. The column does not exist on that table: read the real names with DESCRIBE <table> or get_dataset (its `columns`), and double-quote names that are not plain lower-case identifiers.',
  TABLE_NOT_FOUND:
    'The SQL runs on Trino over fully qualified catalog.schema.table names. Take the table name from get_dataset → `queryable.fqn`, not from the dataset or domain name.',
  SCHEMA_NOT_FOUND:
    'The SQL runs on Trino over fully qualified catalog.schema.table names. Take the table name from get_dataset → `queryable.fqn`; the schema is not derived from the domain name.',
};

/** The Trino error name in a failure message, when it is one of the classes above. */
export function trinoSqlErrorName(message: string): string | null {
  const m = /\bname=([A-Z_]+)\b/.exec(message);
  if (!m || !/\btype=USER_ERROR\b/.test(message)) return null;
  return Object.hasOwn(HINTS, m[1]) ? m[1] : null;
}

/** `{code: 'sql_error', hint}` for a Trino SQL error of a known class, else null. */
export function trinoSqlError(message: string): { code: typeof SQL_ERROR; hint: string; trinoError: string } | null {
  const name = trinoSqlErrorName(message);
  return name ? { code: SQL_ERROR, hint: HINTS[name], trinoError: name } : null;
}
