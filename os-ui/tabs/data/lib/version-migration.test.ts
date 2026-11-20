/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The dry-run plan for the retired dataset version log (WP-37)
 * USER STORY: As the operator I want the plan to name every record's fate and flag every dataset
 *             whose table is shared, so that nothing is lost and no shared table is touched.
 * ARCHITECTURE: pure planner over in-memory datasets; the script only prints it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Dataset } from '@tabs/data/lib/dataset-schema';
import { gitEvidenceFromLog, planVersionMigration, recordsFromJson } from '@tabs/data/lib/version-migration';

const built = { built: true, passThrough: false, quality: 'passing', updatedAt: '2026-11-18T00:00:00Z', artifact: null };
const none = { built: false, passThrough: false, quality: 'unknown', updatedAt: null, artifact: null };
const ds = (id: string, name: string, extra: Partial<Dataset> & { archived?: boolean } = {}) => ({
  version: '1', id, name, owner: 'aborek', domain: 'agentic-leader', tier: 'dataset', visibility: 'private', folder: '/',
  description: '', versions: { bronze: built, silver: none, gold: built }, grants: [], measures: [], columns: [], ...extra,
}) as unknown as Dataset & { archived?: boolean };

const datasets = [
  ds('ds_r0ejqrd65h', 'Northpeak Goods Receipts', { laneSlug: 'northpeak_goods_receipts_r0ejqrd65h' }),
  ds('ds_old1', 'Northpeak Goods Receipts Legacy'),
  ds('ds_dup1', 'Gold Northpeak Receipts'),
  ds('ds_dup2', 'Gold Northpeak Receipts', { archived: true }),
];
const records = [
  { artifactId: 'ds_r0ejqrd65h', version: 1, at: '2026-11-17T10:00:00Z', author: 'aborek', summary: 'edit docs', state: { yaml: 'x' } },
  { artifactId: 'ds_gone', version: 3, at: '2026-11-01T10:00:00Z', author: 'aborek', summary: 'edit', state: { yaml: 'y' } },
];

/** A real domain repo: commits with the OS-Object trailer at fixed committer dates. */
function repoWith(commits: { when: string; trailer: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'wp37-repo-'));
  const git = (args: string[], env: Record<string, string> = {}) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, ...env } });
  git(['init', '-q']);
  commits.forEach((c, i) => {
    writeFileSync(join(dir, `f${i}`), String(i));
    git(['add', `f${i}`]);
    git(['-c', 'user.name=os', '-c', 'user.email=os@example.invalid', 'commit', '-q', '-m', `edit\n\n${c.trailer}`], { GIT_COMMITTER_DATE: c.when, GIT_AUTHOR_DATE: c.when });
  });
  return dir;
}

test('superseded-by-git only with git proof on both sides of the record; otherwise kept-unverified', () => {
  const recs = [
    { artifactId: 'ds_r0ejqrd65h', version: 1, at: '2026-11-17T10:00:00Z', author: 'aborek', summary: 'edit', state: { yaml: 'x' } },
    { artifactId: 'ds_old1', version: 1, at: '2026-11-17T10:00:00Z', author: 'aborek', summary: 'edit', state: { yaml: 'y' } },
    { artifactId: 'ds_dup1', version: 1, at: '2026-11-17T10:00:00Z', author: 'aborek', summary: 'edit', state: { yaml: 'z' } },
  ];
  const repo = repoWith([
    { when: '2026-11-16T09:00:00Z', trailer: 'OS-Object: ds_r0ejqrd65h (Northpeak Goods Receipts)' },
    { when: '2026-11-17T10:00:05Z', trailer: 'OS-Object: ds_r0ejqrd65h (Northpeak Goods Receipts)' },
    { when: '2026-11-16T09:00:00Z', trailer: 'OS-Object: ds_old1' }, // only BEFORE: the replacing edit never reached git
    { when: '2026-11-18T09:00:00Z', trailer: 'OS-Object: metric:ds_dup1.revenue' }, // a metric trailer is not the dataset
  ]);
  const git = gitEvidenceFromLog(execFileSync('git', ['-C', repo, 'log', '--all', '--format=%cI%x1f%B%x1e'], { encoding: 'utf8' }));
  const p = planVersionMigration(datasets, recs, git);
  assert.deepEqual(p.records.map((r) => r.action), ['superseded-by-git', 'kept-unverified', 'kept-unverified']);
  // Negative twin: the same records with NO git evidence are never marked superseded.
  assert.ok(planVersionMigration(datasets, recs).records.every((r) => r.action === 'kept-unverified'));
});

test('every record gets a fate; every dataset gets its own table or the reason it has none', () => {
  const p = planVersionMigration(datasets, records);
  assert.deepEqual(p.records.map((r) => r.action), ['kept-unverified', 'orphan']);
  const by = Object.fromEntries(p.datasets.map((d) => [d.datasetId, d]));
  assert.equal(by.ds_r0ejqrd65h.status, 'own_table');
  assert.equal(by.ds_r0ejqrd65h.versionsFrom, 'iceberg.personal_aborek.gold_northpeak_goods_receipts_r0ejqrd65h');
  assert.equal(by.ds_old1.status, 'legacy_lane_read_only');
  assert.equal(by.ds_dup1.status, 'shared_table');
  assert.deepEqual(by.ds_dup1.siblings, ['ds_dup2'], 'an ARCHIVED sibling still counts');
  assert.equal(by.ds_dup2.status, 'shared_table');
  assert.equal(p.summary.sharedTable, 2);
});

test('the script is dry-run only: --apply is refused, the plan exits 1 when a table is shared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp37-plan-'));
  writeFileSync(join(dir, 'd.json'), JSON.stringify(datasets));
  writeFileSync(join(dir, 'r.json'), JSON.stringify({ hits: { hits: records.map((_source) => ({ _source })) } }));
  assert.equal(recordsFromJson(JSON.stringify({ hits: { hits: records.map((_source) => ({ _source })) } })).length, 2);
  const runIt = (extra: string[]) => {
    try { execFileSync(process.execPath, ['--import', './scripts/test-setup.mjs', 'scripts/plan-dataset-versions.ts', ...extra], { stdio: 'pipe' }); return 0; }
    catch (e) { return (e as { status: number }).status; }
  };
  assert.equal(runIt(['--apply', join(dir, 'd.json'), join(dir, 'r.json')]), 2);
  assert.equal(runIt([join(dir, 'd.json'), join(dir, 'r.json')]), 1);
});
