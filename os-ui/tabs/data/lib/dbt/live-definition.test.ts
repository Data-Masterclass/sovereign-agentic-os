/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-51 — a dataset's live tag names a commit that HOLDS its current dbt model
 * USER STORY: As an engineer I want `git checkout live/dataset/<id>` to give me the dbt project as it
 *             was when the dataset went live, written by the data tab's own generator — not whatever
 *             main happened to hold.
 * ARCHITECTURE:
 *   - The real store, the real commit hook (the one writer configuration) and a real bare repo in a
 *     temp dir; the commit is read back with plain `git`.
 *   - Negative twin: with no writer running, `commitDataDefinition` writes nothing and says so (null),
 *     which go-live turns into `OS-Definition: not-in-git`.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '@tabs/data/lib/store';
import type { Principal } from '@tabs/data/lib/store';
import { __resetProjectListeners } from '@tabs/data/lib/project-events';
import { installDataProjectCommitHook, __setDataProjectGitForTests, commitDataDefinition } from '@tabs/data/lib/dbt/commit';
import { mainSha } from '@core/infra/git-store';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
let repos = '';
let off: (() => void) | null = null;

beforeEach(() => {
  store.__resetStore();
  __resetProjectListeners();
  repos = mkdtempSync(join(tmpdir(), 'wp51-data-'));
});
afterEach(() => {
  off?.();
  off = null;
  __setDataProjectGitForTests(null);
  rmSync(repos, { recursive: true, force: true });
});

test('WP-51: the definition commit holds the dataset as the store has it NOW, through the running writer', async () => {
  __setDataProjectGitForTests(true);
  off = installDataProjectCommitHook({ reposDir: repos, mirror: false });
  const d = store.createDataset(amir, { name: 'Orders' });
  store.buildVersion(d.id, amir, 'bronze', { quality: 'passing', artifact: 'bronze/orders.dlt.yml' });
  store.buildVersion(d.id, amir, 'silver', { quality: 'passing', artifact: 'silver/stg_orders.sql', body: 'create or replace table iceberg.personal_amir.silver_orders as select * from iceberg.personal_amir.bronze_orders', compiled: true });
  // No await of the hook: go-live must settle in-flight commits itself.
  const r = await commitDataDefinition('sales', { id: 'amir' }, { object: 'Orders', objectId: d.id }, { reposDir: repos });
  assert.ok(r?.sha);
  assert.equal(r!.sha, await mainSha('sales', { reposDir: repos }), 'the commit that holds it is main at go-live');
  const tree = execFileSync('git', ['--git-dir', join(repos, 'sales.git'), 'ls-tree', '-r', '--name-only', r!.sha], { env, encoding: 'utf8' });
  assert.match(tree, /dbt_project\.yml/);
  assert.match(tree, /models\/.*orders/i, `the dataset's model is in the committed project:\n${tree}`);
});

test('WP-51 negative twin: with no data writer running, nothing is written and the answer is null', async () => {
  __setDataProjectGitForTests(true);
  store.createDataset(amir, { name: 'Orders' });
  const r = await commitDataDefinition('sales', { id: 'amir' }, { object: 'Orders', objectId: 'x' }, { reposDir: repos });
  assert.equal(r, null);
  assert.equal(await mainSha('sales', { reposDir: repos }), null, 'no repo, no commit');
});
