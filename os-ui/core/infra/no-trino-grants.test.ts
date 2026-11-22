/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS never sets access rights in Trino with SQL (ownership rule: rights are the OS's,
 *             through OPA and the rules file it writes)
 * USER STORY: As a platform admin I want one place where access is decided: OPA, fed by the OS. A
 *             `GRANT` run against Trino would be a second, invisible owner.
 * ARCHITECTURE: scans EVERY non-test os-ui source (ts, tsx, mjs), after removing comments and joining
 *   concatenated literals ('GRA' + 'NT ...'), for access statements anywhere inside a string:
 *   GRANT/REVOKE/DENY followed by a privilege word, role statements, a template-built
 *   `GRANT ${priv} ON`, and a bare 'GRANT' / 'REVOKE' literal (the start of a built string
 *   or a `['GRANT', ...].join(' ')`). There must be none, except the explicit allowlist: Postgres
 *   code, whose GRANT is not Trino.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', new URL('..', import.meta.url)).pathname.replace(/\/$/, '');
const SKIP = new Set(['node_modules', '.next', 'vendor']);
/** Postgres, not Trino: the governance database's own migrations grant to its own roles. */
export const ALLOWED = new Set<string>(['core/adapters/postgres/migrate.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(n) && !/\.test\.|\.int\.|\.it\./.test(n)) out.push(p);
  }
  return out;
}

const PRIV = '(?:select|insert|update|delete|all|ownership|usage|create|execute|show|alter|drop|with)';
// A privilege list, then ON / TO / FROM: "Grant all access" in a UI label has none of those.
const VERBS = new RegExp(
  `\\b(?:grant|revoke|deny)\\s+(?:${PRIV}\\b[\\w, ()]*?)\\s+(?:on|to|from)\\b` +
    `|\\b(?:grant|revoke|deny)\\s+\\$\\{\\s+(?:on|to|from)\\b` +
    `|\\b(?:create|drop)\\s+role\\s+\\w|\\bset\\s+role\\s+\\w`,
  'i',
);
/** Upper-case only: 'grant' alone is an everyday enum value, and 'DENY' is an HTTP header value; the SQL keyword is written in capitals. */
const BARE = /(['"`])\s*(?:GRANT|REVOKE)\s*\1/;
/** `GRANT role TO user`, upper-case only ('grant it to' is prose). */
const ROLE_GRANT = /\bGRANT\s+\w+\s+TO\s+\w/;

/** Remove comments, join `'a' + 'b'` literals, and make `${...}` a plain token. */
export function normalise(src: string): string {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (let i = 0; i < 20; i++) {
    const joined = s.replace(/(['"`])\s*\+\s*\1|(['"`])\s*\+\s*(['"`])/g, '');
    if (joined === s) break;
    s = joined;
  }
  return s.replace(/\$\{[^}]*\}/g, '${');
}

/** The string-literal contents of a normalised source. */
function literals(src: string): string[] {
  return [...src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

export function accessSqlIn(src: string): string[] {
  const n = normalise(src);
  const hits = literals(n).filter((l) => VERBS.test(l) || ROLE_GRANT.test(l));
  if (BARE.test(n)) hits.push('(a bare GRANT/REVOKE literal)');
  return hits;
}

test('no os-ui source sends GRANT, REVOKE, DENY or a role statement, however it is built', () => {
  const hits = walk(ROOT).map((f) => [relative(ROOT, f), accessSqlIn(readFileSync(f, 'utf8'))] as const).filter(([f, h]) => h.length > 0 && !ALLOWED.has(f));
  assert.deepEqual(hits.map(([f, h]) => `${f}: ${h[0].slice(0, 80)}`), []);
});

test('twin: concatenated, template-built, array-built and lower-case statements ARE caught', () => {
  const caught = [
    "const q = 'GRANT SELECT ON iceberg.sales.t TO alice';",
    "const q = 'GRA' + 'NT SELECT ON t TO bob';",
    "const q = 'REVOKE ' + 'INSERT ON t FROM bob';",
    'const q = `GRANT ${priv} ON ${t} TO ${u}`;',
    "const q = ['GRANT', priv, 'ON', t].join(' ');",
    "const q = \"deny select on t to carol\";",
    "const q = 'CREATE ROLE analysts';",
    "run('SET ROLE admin')",
  ];
  for (const c of caught) assert.ok(accessSqlIn(c).length > 0, c);
});

test('twin: prose, comments and unrelated words are not caught', () => {
  const quiet = [
    "const t = 'Grant access in the OS';",
    "// GRANT SELECT ON t TO alice is never sent",
    "/* REVOKE INSERT ON t */ const x = 1;",
    "const label = 'Revoke approval';",
    "const s = 'deny by default';",
  ];
  for (const c of quiet) assert.deepEqual(accessSqlIn(c), [], c);
});
