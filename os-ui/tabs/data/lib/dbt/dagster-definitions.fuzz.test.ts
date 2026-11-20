/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Fuzz test — no user text can change the CODE of the generated `definitions.py`
 * USER STORY: As the owner I want a dataset name, an owner, a connection, a table, a cursor, a cron,
 *             authored SQL or a domain carrying a newline, a quote, a triple quote or a Python
 *             keyword to stay data: the code server executes this module (review of WP-49, finding 3).
 * ARCHITECTURE:
 *   - The independent verifier's hostile values × every user-controlled field, through the real
 *     generator (`generateProjectReport`). Each module is then read by Python's OWN parser
 *     (`ast`, `tokenize`, `python3 -I`) and compared with the module generated from benign values:
 *     the sequence of top-level statements, the imports and the number of comments must be identical,
 *     and the library/builtin callees may only be a subset. A value that leaks into code changes one.
 *   - Python is required (as for GLUE-10); a missing interpreter fails the test, it never skips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { emptyVersions } from '@tabs/data/lib/dataset-schema';
import { DATA_LAYOUT } from '@core/infra/data-layout';
import { generateProjectReport } from '@tabs/data/lib/dbt/generate';
import { LiteralSafetyError } from '@tabs/data/lib/dbt/literal';
import type { ProjectSnapshot } from '@tabs/data/lib/dbt/snapshot';

const HOSTILE = [
  'x\nimport os; os.system("id")\n#',
  'x\rimport os\r#',
  'x\r\nexec("1")',
  '"; import os; "',
  "'; import os; '",
  '"""\nimport os\n"""',
  "'''\nimport os\n'''",
  '\\',
  '\\"); import os; ("',
  '${DOMAIN}',
  '{}',
  '# comment',
  ' import os',
  ' import os',
  '\u0085import os',
  'nul\u0000byte',
  'lone\ud800surrogate',
  '../../etc/passwd',
  '/abs/path',
  'class',
  'None',
  'exec',
  '__import__',
  'print',
  'dg',
  'dlt',
  'defs',
  'DOMAIN',
  'all',
  '1leading_digit',
  '',
];

const built = (artifact: string | null) => ({ built: true, passThrough: false, quality: 'unknown' as const, updatedAt: '2026-11-13T00:00:00.000Z', artifact });

type Fields = { domain: string; id: string; name: string; owner: string; conn: string; schema: string; table: string; cursor: string; cron: string; description: string; sql: string };
const BENIGN: Fields = { domain: 'sales', id: 'ds_shop0001', name: 'Shop Orders', owner: 'alice', conn: 'conn_shop', schema: 'public', table: 'orders', cursor: 'updated_at', cron: '0 * * * *', description: 'Orders.', sql: 'select 1 as x' };

function snapshot(f: Fields): ProjectSnapshot {
  const d: Dataset = {
    version: '1', tier: 'dataset', visibility: 'private', folder: '/', grants: [], measures: [], columns: [], viewNamespaced: true,
    id: f.id, name: f.name, owner: f.owner, domain: f.domain, description: f.description,
    sync: { connectionId: f.conn, source: { schema: f.schema, table: f.table }, mode: 'append', cursor: { kind: 'timestamp', column: f.cursor }, schedule: { cron: f.cron }, enabled: true },
    versions: { ...emptyVersions(), bronze: built(null), silver: built('silver/x.sql') },
  };
  return { domain: f.domain, datasets: [{ dataset: d, artifacts: { 'silver/x.sql': f.sql } }], catalogs: { [f.conn]: 'shop' } };
}

const SHAPE_PY = String.raw`
import ast, io, json, sys, tokenize
out = []
for src in json.load(sys.stdin):
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        out.append({"error": f"SyntaxError: {e.msg}"}); continue
    comments = sum(1 for t in tokenize.generate_tokens(io.StringIO(src).readline) if t.type == tokenize.COMMENT)
    # Callees that are NOT the module's own (sanitised, generated) names: imports and builtins. A leak
    # that calls os/exec/eval/__import__ shows up here; generated identifiers legitimately differ.
    imported = {(a.asname or a.name).split(".")[0] for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}
    root = lambda f: f.id if isinstance(f, ast.Name) else (f.value.id if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) else None)
    calls = sorted({r for n in ast.walk(tree) if isinstance(n, ast.Call) for r in [root(n.func)] if r and (r in imported or r in dir(__builtins__))})
    out.append({"top": [type(n).__name__ for n in tree.body], "comments": comments, "calls": calls, "imports": sorted(ast.unparse(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom)))})
json.dump(out, sys.stdout)
`;

function shapes(sources: string[]): Record<string, unknown>[] {
  const r = spawnSync('python3', ['-I', '-c', SHAPE_PY], { input: JSON.stringify(sources), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `python3 is required for this test: ${r.error?.message ?? r.stderr}`);
  return JSON.parse(r.stdout);
}

test('fuzz: no hostile value in any user field changes the structure of definitions.py', () => {
  // A value the generator refuses outright (a hostile domain fails the whole tree closed with a
  // LiteralSafetyError) produces no module at all, which is the safe outcome.
  const module = (f: Fields) => {
    try {
      return generateProjectReport(f.domain, snapshot(f)).files.get(DATA_LAYOUT.dagsterDefinitionsPath);
    } catch (e) {
      if (e instanceof LiteralSafetyError) return undefined;
      throw e;
    }
  };
  const baseline = module(BENIGN);
  assert.ok(baseline, 'the benign snapshot generates a module');
  const cases: { label: string; src: string }[] = [];
  for (const field of Object.keys(BENIGN) as (keyof Fields)[]) {
    for (const v of HOSTILE) {
      const src = module({ ...BENIGN, [field]: v });
      if (src !== undefined) cases.push({ label: `${field}=${JSON.stringify(v)}`, src });
    }
  }
  // Free text (name, description) always reaches the module, so every hostile value there is
  // exercised; an identifier field (or an authored SQL body with a brace or a lone surrogate)
  // holding one is refused before rendering by the literal-safety rules, so those cases yield no
  // module and are proven safe by refusal instead (literal-safety.fuzz.test.ts).
  for (const field of ['name', 'description'] as const) {
    for (const v of HOSTILE) assert.ok(cases.some((c) => c.label === `${field}=${JSON.stringify(v)}`), `free text ${field}=${JSON.stringify(v)} generated no module`);
  }
  assert.ok(cases.length > 120, `enough generated modules (${cases.length})`);
  const [base, ...rest] = shapes([baseline!, ...cases.map((c) => c.src)]);
  assert.ok(!('error' in base), 'the baseline parses');
  const b = base as { calls: string[] };
  rest.forEach((s, i) => {
    const got = s as { calls?: string[]; error?: string };
    assert.ok(!got.error, `${cases[i].label}: ${got.error}`);
    // Identical code shape; callees may only be a SUBSET (an unrecognised cron drops the optional
    // freshness check), never a new one.
    assert.deepEqual({ ...got, calls: undefined }, { ...base, calls: undefined }, `user text changed the module's code: ${cases[i].label}`);
    const extra = (got.calls ?? []).filter((c) => !b.calls.includes(c));
    assert.deepEqual(extra, [], `user text added a call: ${cases[i].label}`);
  });
});
