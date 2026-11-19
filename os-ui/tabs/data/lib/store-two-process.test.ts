/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        data
 * FEATURE:    An agent's dataset write in the worker never overwrites a newer edit made in the web app
 * USER STORY: As a creator I rename my dataset or add a quality rule in the Data tab while an
 *             agent (running in the worker pod) documents it or defines a metric on it. After the
 *             agent finishes and os-ui restarts, my edit is still there — and so is what the agent
 *             did. It works the other way round too: an edit in os-ui made after the agent wrote
 *             does not erase the agent's work.
 * ARCHITECTURE:
 *   - Two simulated processes over one fake OpenSearch, through the REAL store
 *     (`core/infra/two-process-fixture.ts`). A restart is an empty process that hydrates.
 *   - Every dataset operation rewrites the ONE `yaml` field, so this is the store where a
 *     field-level partial write is not enough: the store re-reads the newest copy and merges by
 *     the dataset's own top-level fields (`core/infra/field-writes.ts` `mergeChanged`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as, settle, type Proc } from '@core/infra/two-process-fixture';
import * as store from '@tabs/data/lib/store';

const KEYS = [Symbol.for('soa.data.store')];
const bea: store.Principal = { id: 'bea', domains: ['sales'], role: 'builder' };

async function scenario() {
  const os = fakeCluster();
  store.__resetStore();
  const web = proc();
  const id = await as(web, KEYS, async () => {
    await store.ensureHydrated();
    return store.createDataset(bea, { name: 'Orders', domain: 'sales' }).id;
  });
  const worker = proc(true);
  await as(worker, KEYS, () => store.ensureHydrated()); // the worker boots after the dataset exists
  return { os, web, worker, id };
}

async function restart(): Promise<Proc> {
  const fresh = proc();
  await as(fresh, KEYS, () => store.ensureHydrated());
  return fresh;
}

test('an agent documenting a dataset in the worker keeps a rename made meanwhile in os-ui', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => store.renameDataset(id, bea, 'Orders (EU)'));
    await as(worker, KEYS, () => store.setDocs(id, bea, { description: 'One row per order.' }));
    await settle();

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getDataset(id, bea));
    assert.equal(back.name, 'Orders (EU)', 'the rename made in os-ui must survive the agent documenting the dataset');
    assert.equal(back.description, 'One row per order.', "the agent's documentation is kept");
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test("an edit in os-ui made after the agent wrote does not erase the agent's work", async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(worker, KEYS, () => store.setDocs(id, bea, { description: 'One row per order.' }));
    await settle();
    // os-ui still holds its boot-time copy (no description) and renames.
    await as(web, KEYS, () => store.renameDataset(id, bea, 'Orders (EU)'));
    await settle();

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getDataset(id, bea));
    assert.equal(back.name, 'Orders (EU)');
    assert.equal(back.description, 'One row per order.', "the agent's documentation survives the later web edit");
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test('a dataset deleted in os-ui is not brought back by an agent write in the worker', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => {
      store.archiveDataset(id, bea);
      store.deleteDataset(id, bea);
    });
    await as(worker, KEYS, () => store.setDocs(id, bea, { description: 'Too late.' }));
    await settle();
    assert.equal(os.doc('os-datasets', id), undefined, 'the worker write must not re-create the deleted dataset');
  } finally {
    os.restore();
    store.__resetStore();
  }
});
