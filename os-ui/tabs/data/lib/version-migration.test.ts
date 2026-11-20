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
import { planVersionMigration, recordsFromJson } from '@tabs/data/lib/version-migration';

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

test('every record gets a fate; every dataset gets its own table or the reason it has none', () => {
  const p = planVersionMigration(datasets, records);
  assert.deepEqual(p.records.map((r) => r.action), ['superseded-by-git', 'orphan']);
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
