/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * WP-56 — the chart refuses a restore drill that could pass without proving anything.
 * The Postgres check needs `backup.drill.postgresCompare.criticalTables`: without it a small table
 * that restores EMPTY passes inside the row-drift allowance (minDriftRows). Twins: the same values
 * with the list set render, and a drill without the Postgres check needs no list.
 *
 * Run: needs helm + `helm dependency build`; node --test tests/backup/render-guards.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = [
  `backup.gitBundles.image.digest=sha256:${'0'.repeat(64)}`, 'backup.gitBundles.bucket=soa-bundles',
  'backup.drill.enabled=true',
];
function render(sets) {
  const args = ['template', 't', join(ROOT, 'charts', 'sovereign-agentic-os'), '-n', 'agentic-os'];
  for (const s of [...BASE, ...sets]) args.push('--set', s);
  return spawnSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

test('NEGATIVE: the Postgres drill without criticalTables refuses to render', () => {
  const r = render(['backup.pgDump.enabled=true']);
  assert.notEqual(r.status, 0, 'the render must fail');
  assert.match(r.stderr, /needs backup\.drill\.postgresCompare\.criticalTables/);
});

test('the Postgres drill with criticalTables renders them into the drill', () => {
  const r = render(['backup.pgDump.enabled=true', 'backup.drill.postgresCompare.criticalTables={os:public.users}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /name: PG_DRILL_CRITICAL_TABLES, value: "os:public\.users"/);
});

test('a drill without the Postgres check needs no criticalTables', () => {
  const r = render(['backup.drill.postgres.enabled=false']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /name: agentic-os-restore-drill|restore-drill/);
});
