/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * SINGLE-STATEMENT SQL GUARD — the shared normalizer for every governed query door
 * (the agent `query_data` tool AND the Talk-to `runAsk` path).
 *
 * Models routinely emit `SELECT …;` with a trailing semicolon; Trino's parser
 * rejects a bare `;` with `SYNTAX_ERROR mismatched input ';'`. A trailing separator
 * on an otherwise-single statement is harmless, so we STRIP exactly one (plus any
 * surrounding whitespace) before execution. But a semicolon that survives the strip
 * means a genuine MULTI-statement request — which the governed read path must never
 * run — so we reject it with a CLEAR, actionable message instead of a Trino stack
 * trace.
 *
 * Transport-free + pure (no `server-only` / Next / network), so both the MCP
 * server (`query_data`) and the transport-free ask core can import it.
 */

export const MULTI_STATEMENT_MESSAGE =
  'Only one SQL statement is allowed — remove extra semicolons.';

export type SqlSanitize = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * Trim whitespace and strip a SINGLE trailing `;` (and any whitespace around it) so a
 * normal `SELECT …;` runs. If an internal `;` survives the strip, the input is a
 * genuine multi-statement request → reject with {@link MULTI_STATEMENT_MESSAGE}.
 * A trailing run of semicolons/whitespace (e.g. `SELECT 1 ; ;`) collapses to one
 * statement and passes; a `;` with real SQL after it does not.
 */
export function sanitizeSingleStatement(raw: string): SqlSanitize {
  let sql = (raw ?? '').trim();
  // Peel any purely-trailing semicolons (with surrounding whitespace). This turns
  // "select 1 ;" and "select 1 ; ;" into "select 1"; it does NOT touch a ';' that
  // has real SQL after it (that stays and is caught below as multi-statement).
  while (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd();
  if (sql.includes(';')) return { ok: false, reason: MULTI_STATEMENT_MESSAGE };
  return { ok: true, sql };
}
