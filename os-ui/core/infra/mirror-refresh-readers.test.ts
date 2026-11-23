/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    os-ui switches on the 'changes' refresh of every store the agent worker writes
 * USER STORY: As an operator I trust that the web app re-reads what the worker writes for EVERY
 *             store — not just the one a test happened to switch on by hand.
 * ARCHITECTURE:
 *   - Runs the SAME `enableWebMirrorRefresh` `instrumentation.ts` calls at boot (and asserts the
 *     boot calls it), then reads each store's mode from `mirrorRefreshStatus()`.
 *   - Also the web app's read contract: stale-while-revalidate under an OpenSearch brownout, and
 *     an index whose `updatedAt` is not indexed falls back to the whole-index listing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCluster, proc, as } from '@core/infra/two-process-fixture';
import { later } from '@core/infra/worker-refresh-suite';
import { mirrorRefreshStatus, MIRROR_CHANGES_WAIT_MS } from '@core/infra/mirror-refresh';
import { enableWebMirrorRefresh, WEB_MIRROR_REFRESH_READERS } from '@/mirror-refresh-readers';
import * as folders from '@core/folders/folder-store';
import { __clearRunWorkerProcess } from '@core/kernel/process-role';

const LABELS = ['files', 'datasets', 'metrics-lifecycle', 'knowledge', 'personal-knowledge', 'dashboards', 'connections', 'apps', 'folders'];

test('the boot switches every one of the 9 stores to the \'changes\' refresh', async () => {
  __clearRunWorkerProcess(); // the web app
  const os = fakeCluster();
  try {
    const { on, failed } = await enableWebMirrorRefresh();
    assert.deepEqual(failed, []);
    assert.equal(on.length, 9);
    const status = mirrorRefreshStatus();
    for (const label of LABELS) assert.equal(status[label], 'changes', `${label} reads in 'changes' mode`);
    assert.equal(WEB_MIRROR_REFRESH_READERS.length, 9);
    // …and the shipped boot calls exactly this function.
    const boot = readFileSync(join(process.cwd(), 'instrumentation.ts'), 'utf8');
    assert.match(boot, /await import\('\.\/mirror-refresh-readers\.ts'\);\s*const \{ on, failed \} = await enableWebMirrorRefresh\(\);/);
  } finally {
    for (const [, load] of WEB_MIRROR_REFRESH_READERS) (await load()).enableMirrorRefresh(false);
    os.restore();
  }
});

const KEYS = [Symbol.for('soa.folders.store'), Symbol.for('soa.versions.folder')];
const bea = { id: 'bea', domains: ['sales'], role: 'creator' as const };

test('stale-while-revalidate: under an OpenSearch brownout a web read waits at most a moment, never for the whole index', async () => {
  const os = fakeCluster();
  folders.__resetStore();
  const web = proc();
  try {
    await as(web, KEYS, async () => {
      await folders.ensureHydrated();
      folders.enableMirrorRefresh();
      folders.createFolder(bea, { tab: 'files', scope: 'personal', path: '/kept' });
    });
    os.searchDelayMs = 5000; // every search now takes 5 s
    later();
    const t0 = Date.now();
    await as(web, KEYS, () => folders.ensureHydrated());
    const waited = Date.now() - t0;
    assert.ok(waited < MIRROR_CHANGES_WAIT_MS + 500, `the read waited ${waited} ms`);
    assert.ok(await as(web, KEYS, () => folders.listFolders(bea, 'files', 'personal').length === 1), 'served from memory');
  } finally {
    os.searchDelayMs = 0;
    os.restore();
    folders.__resetStore();
  }
});

test('an index whose updatedAt is NOT indexed is read by the whole-index listing, never "nothing changed"', async () => {
  const os = fakeCluster();
  folders.__resetStore();
  const web = proc();
  const worker = proc(true);
  try {
    os.unmapped.add('os-folders');
    await as(web, KEYS, async () => { await folders.ensureHydrated(); folders.enableMirrorRefresh(); });
    const id = await as(worker, KEYS, () => folders.createFolder(bea, { tab: 'files', scope: 'personal', path: '/by-agent' }).id);
    later();
    await as(web, KEYS, () => folders.ensureHydrated()); // the changes read refuses → a background full listing
    assert.equal(os.searches.filter((x) => x.index === 'os-folders' && x.kind === 'changes').length, 0, 'no blind range query');
    assert.ok(await as(web, KEYS, () => folders.getFolder(id) !== undefined), 'the whole-index listing found it');
  } finally {
    os.restore();
    folders.__resetStore();
  }
});
