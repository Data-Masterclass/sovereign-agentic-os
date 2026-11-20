/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    REPO-LAYOUT rule tests — a hand-built repository path fails, an imported one passes
 * USER STORY: As a maintainer I want proof the rule bites: new code that spells
 *             `agents/<system>/graph.mjs` by hand fails CI; the same code importing the path from
 *             `@core/infra/repo-layout` passes; and the real tree is at or under its baseline.
 * ARCHITECTURE:
 *   - Runs the real script with `--root` on throwaway trees (no baseline ⇒ zero tolerance).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'check-repo-layout.mjs');

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'repo-layout-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
const check = (root) => spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });

test('a hand-built path outside repo-layout.ts FAILS (negative twin)', () => {
  const r = check(tree({ 'os-ui/tabs/zfix/lib/graph.ts': 'export const p = (s: string) => `agents/${s}/graph.mjs`;\n' }));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /REPO-LAYOUT {2}os-ui\/tabs\/zfix\/lib\/graph\.ts/);
});

test('each shape the rule knows is caught', () => {
  for (const src of [
    "const a = 'data/dbt/models/x.sql';",
    "const b = 'os/schedules.yml';",
    "const c = 'models/personal/' + uid;",
    'const d = `${base}/${domain}.git/`;',
    "const e = 'dashboards/sales/chart.vl.json';",
  ]) {
    const r = check(tree({ 'os-ui/core/zfix/x.ts': `${src}\n` }));
    assert.equal(r.status, 1, `${src}\n${r.stdout}`);
  }
});

test('the same code importing the path passes; a Dagster tag is not a path; repo-layout.ts is exempt', () => {
  const r = check(
    tree({
      'os-ui/tabs/zfix/lib/graph.ts': "import { agentGraphPath } from '@core/infra/repo-layout';\nexport const p = agentGraphPath;\nconst tag = 'os/dataset';\n",
      'os-ui/core/infra/repo-layout.ts': "export const X = 'agents/index.yml';\n",
    }),
  );
  assert.equal(r.status, 0, r.stdout);
});

test('the real tree is at or under its baseline', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: join(here, '..', '..') });
  assert.equal(r.status, 0, r.stdout);
});
