/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS never sets access rights in Trino with SQL (ownership rule: rights are the OS's,
 *             through OPA and the rules file it writes)
 * USER STORY: As a platform admin I want one place where access is decided: OPA, fed by the OS. A
 *             `GRANT` run against Trino would be a second, invisible owner.
 * ARCHITECTURE: scans every non-test source that talks to Trino (mentions `queryRun` or Trino) for SQL
 *   string literals that start, right after the quote, with GRANT, REVOKE, DENY or a role statement.
 *   There must be none. (Postgres migrations legitimately GRANT; they are not Trino.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', new URL('..', import.meta.url)).pathname.replace(/\/$/, '');
const SKIP = new Set(['node_modules', '.next', 'vendor']);
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(n) && !/\.test\.|\.int\.|\.it\./.test(n)) out.push(p);
  }
  return out;
}

/** A string literal whose content begins with an access statement. */
export const ACCESS_SQL = /(['"`])(GRANT\s+[A-Za-z_, ]+\s+ON\b|REVOKE\s+[A-Za-z_, ]+\s+ON\b|DENY\s+[A-Za-z_, ]+\s+ON\b|CREATE\s+ROLE\b|DROP\s+ROLE\b|SET\s+ROLE\b|GRANT\s+\w+\s+TO\b)/i;

test('no source sends GRANT, REVOKE, DENY or a role statement to Trino', () => {
  const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hits = walk(ROOT).filter((f) => { const t = code(f); return /queryRun|trino/i.test(t) && ACCESS_SQL.test(t); }).map((f) => relative(ROOT, f));
  assert.deepEqual(hits, []);
});

test('twin: the pattern does catch the statements it is meant to forbid', () => {
  for (const s of ["'GRANT SELECT ON iceberg.sales.t TO alice'", '`REVOKE INSERT ON t FROM bob`', '"CREATE ROLE analysts"', "'SET ROLE admin'"]) {
    assert.ok(ACCESS_SQL.test(s), s);
  }
  assert.ok(!ACCESS_SQL.test("'Grant access in the OS'"), 'prose is not SQL');
});
