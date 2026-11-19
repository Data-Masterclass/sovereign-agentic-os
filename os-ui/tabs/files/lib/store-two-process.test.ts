/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        files
 * FEATURE:    An agent's file write in the worker never overwrites a newer edit made in the web app
 * USER STORY: As a creator I rename my file in the Files tab while an agent (running in the worker
 *             pod) writes its description. After the agent finishes and os-ui restarts, my rename
 *             is still there — and so is the description. A file I deleted stays deleted.
 * ARCHITECTURE:
 *   - Two simulated processes over one fake OpenSearch, through the REAL store
 *     (`core/infra/two-process-fixture.ts`). The worker is a reader of the mirror, as in
 *     production (`enableMirrorRefresh`), but its copy can still be older than the last edit
 *     (refreshes are throttled), so the write itself must not send that copy back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as, settle, type Proc } from '@core/infra/two-process-fixture';
import * as store from '@tabs/files/lib/store';

const KEYS = [Symbol.for('soa.files.store')];
const INDEX = 'os-file-records';
const bea: store.Principal = { id: 'bea', domains: ['sales'], role: 'creator' };

async function scenario() {
  const os = fakeCluster();
  store.__resetStore();
  const web = proc();
  const id = await as(web, KEYS, async () => {
    await store.ensureHydrated();
    return store.createFile(bea, { name: 'returns-policy.md', text: 'Refunds within 30 days.' }).id;
  });
  const worker = proc(true);
  await as(worker, KEYS, () => store.ensureHydrated()); // the worker boots after the file exists
  return { os, web, worker, id };
}

async function restart(): Promise<Proc> {
  const fresh = proc();
  await as(fresh, KEYS, () => store.ensureHydrated());
  return fresh;
}

test('an agent describing a file in the worker keeps a rename made meanwhile in os-ui', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => store.renameFile(id, bea, 'refund-policy.md'));
    await as(worker, KEYS, () => store.setDocs(id, bea, { description: 'The refund rules.' }));
    await settle();

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getFile(id, bea));
    assert.equal(back.asset.name, 'refund-policy.md', 'the rename made in os-ui must survive the agent describing the file');
    assert.equal(back.asset.description, 'The refund rules.', "the agent's description is kept");
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test('a file deleted in os-ui is not brought back by an agent write in the worker', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => store.deleteFile(id, bea));
    assert.equal(os.doc(INDEX, id), undefined, 'the delete reached the mirror');
    await as(worker, KEYS, () => store.setDocs(id, bea, { description: 'Too late.' }));
    await settle();
    assert.equal(os.doc(INDEX, id), undefined, 'the worker write must not re-create the deleted file');
  } finally {
    os.restore();
    store.__resetStore();
  }
});
