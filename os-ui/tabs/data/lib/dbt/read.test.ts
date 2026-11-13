/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Read-access + mirror-config tests for the data-project repos
 * USER STORY: As a maintainer I want proof that only domain members read a project, that a missing
 *             repo is a 404 (not a crash), that exports are real tars, and that the mirror record
 *             holds a Secret REFERENCE and never the token.
 * ARCHITECTURE:
 *   - Real git store in a temp dir, written through `commitDataProject` with the flag pinned on.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '@tabs/data/lib/store';
import type { Principal } from '@tabs/data/lib/store';
import { DatasetError } from '@tabs/data/lib/dataset-schema';
import { tarList } from '@core/infra/tar';
import { putSecret } from '@core/infra/secrets';
import { __setDataProjectGitForTests, commitDataProject } from '@tabs/data/lib/dbt/commit';
import { readProject, readProjectBlob, exportProject } from '@tabs/data/lib/dbt/read';
import { setProjectMirror, getProjectMirror, clearProjectMirror, pushProjectMirror, __resetProjectMirrors } from '@tabs/data/lib/dbt/mirror';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-read-'));
  __setDataProjectGitForTests(true);
});
after(() => {
  rmSync(reposDir, { recursive: true, force: true });
  __setDataProjectGitForTests(null);
});
beforeEach(() => {
  store.__resetStore();
  __resetProjectMirrors();
});

test('readProject: 404 before any commit, then tree + log; blob + export at a ref; non-members get 403', async () => {
  await assert.rejects(readProject('sales', amir, { reposDir }), (e: unknown) => e instanceof DatasetError && e.status === 404);
  const d = store.createDataset(amir, { name: 'Orders' });
  store.buildVersion(d.id, amir, 'bronze', { artifact: 'bronze/orders.dlt.yml' });
  store.buildVersion(d.id, amir, 'silver', { artifact: 'silver/stg_orders.sql', passThrough: true });
  const r1 = await commitDataProject('sales', { id: 'amir', name: 'Amir', email: 'amir@x.io' }, { action: 'build silver', object: 'orders', surface: 'ui:data', requestId: 'req_1' }, { reposDir, mirror: false });
  assert.equal(r1?.changed, true);
  const view = await readProject('sales', amir, { reposDir });
  assert.equal(view.head, r1!.sha);
  assert.ok(view.tree.some((t) => t.path === 'models/personal/amir/silver_orders.sql'));
  assert.equal(view.log.length, 1);
  assert.equal(view.log[0].trailers['OS-Request-Id'], 'req_1');
  assert.deepEqual(view.log[0].author, { name: 'Amir', email: 'amir@x.io' });

  const blob = await readProjectBlob('sales', amir, 'main', 'models/personal/amir/silver_orders.sql', { reposDir });
  assert.match(blob.content, /select \* from \{\{ source\('personal_amir', 'bronze_orders'\) \}\}/);
  await assert.rejects(readProjectBlob('sales', amir, 'main', '', { reposDir }), (e: unknown) => e instanceof DatasetError && e.status === 400);

  const exp = await exportProject('sales', amir, r1!.sha, { reposDir });
  assert.equal(exp.filename, `sales-${r1!.sha.slice(0, 7)}.tar`);
  const names = tarList(exp.tar).map((e) => e.path);
  assert.ok(names.includes('dbt_project.yml') && names.includes('profiles.yml') && names.includes('models/sources.yml'));

  await assert.rejects(readProject('sales', kenji, { reposDir }), (e: unknown) => e instanceof DatasetError && e.status === 403);
  await assert.rejects(exportProject('sales', kenji, undefined, { reposDir }), (e: unknown) => e instanceof DatasetError && e.status === 403);

  // Regenerating the same state commits nothing.
  const r2 = await commitDataProject('sales', { id: 'amir' }, { action: 'noop' }, { reposDir, mirror: false });
  assert.equal(r2?.changed, false);
  assert.equal(r2?.sha, r1!.sha);
});

test('mirror config: validates url + secret reference, stores no token, push reports (never throws)', async () => {
  assert.throws(() => setProjectMirror('sales', { url: 'ftp://x', tokenSecretRef: { name: 'm', key: 'k' } }, amir), (e: unknown) => e instanceof DatasetError && e.status === 400);
  assert.throws(() => setProjectMirror('sales', { url: 'http://query-tool:8000/x.git', tokenSecretRef: { name: 'm', key: 'k' } }, amir), /egress allowlist/);
  assert.throws(() => setProjectMirror('sales', { url: 'https://github.com/org/sales.git', tokenSecretRef: { name: 'm', key: 'k' } }, amir), /not set/);
  const ref = putSecret('mirror-sales', 'token', 'ghp_super_secret_value');
  const rec = setProjectMirror('sales', { url: 'https://github.com/org/sales.git', tokenSecretRef: ref }, amir);
  assert.deepEqual(rec.tokenSecretRef, { name: 'mirror-sales', key: 'token' });
  assert.doesNotMatch(JSON.stringify(rec), /ghp_super_secret_value/);
  assert.equal(getProjectMirror('sales')?.url, 'https://github.com/org/sales.git');
  assert.equal(await pushProjectMirror('finance', { reposDir }), null, 'no mirror ⇒ null');
  const res = await pushProjectMirror('sales', { reposDir });
  assert.equal(res?.ok, false, 'no repo yet ⇒ an honest failure, not a throw');
  assert.doesNotMatch(JSON.stringify(getProjectMirror('sales')), /ghp_super_secret_value/);
  assert.equal(clearProjectMirror('sales'), true);
  assert.equal(getProjectMirror('sales'), null);
});
