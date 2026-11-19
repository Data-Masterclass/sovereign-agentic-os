/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    An agent's knowledge write in the worker never overwrites a newer edit made in the web app
 * USER STORY: As a creator I edit my workflow in the Knowledge tab while an agent (running in the
 *             worker pod) archives it or imports an OKF bundle into it. After the agent finishes
 *             and os-ui restarts, my edit is still there — and so is what the agent did.
 * ARCHITECTURE:
 *   - Two simulated processes (`os-ui` and `os-ui-worker`) over one fake OpenSearch, through the
 *     REAL store (`core/infra/two-process-fixture.ts`). A restart is an empty process that
 *     hydrates from the mirror, exactly as a pod does at boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as, type Proc } from '@core/infra/two-process-fixture';
import * as store from '@tabs/knowledge/lib/store';

const KEYS = [Symbol.for('soa.knowledge.store')];
const INDEX = 'os-knowledge-records';
const bea: store.Principal = { id: 'bea', domains: ['sales'], role: 'creator' };

async function scenario() {
  const os = fakeCluster();
  store.__resetStore();
  const web = proc();
  const worker = proc(true);
  const id = await as(web, KEYS, async () => {
    await store.ensureHydrated();
    return store.createWorkflow(bea, { title: 'Refunds' }).id;
  });
  // The worker boots after the workflow exists: its copy is the one it hydrated.
  await as(worker, KEYS, () => store.ensureHydrated());
  return { os, web, worker, id };
}

async function editMdInWeb(web: Proc, id: string): Promise<string> {
  return as(web, KEYS, () => {
    const cur = store.getWorkflow(id, bea);
    const md = cur.md.replace(/\n*$/, '\n\nEscalate refunds above 500 EUR to finance.\n');
    store.updateWorkflow(id, bea, { md, sha: cur.sha });
    return md;
  });
}

async function restart(): Promise<Proc> {
  const fresh = proc();
  await as(fresh, KEYS, () => store.ensureHydrated());
  return fresh;
}

test('an agent archiving a workflow in the worker keeps the edit made meanwhile in os-ui', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    const edited = await editMdInWeb(web, id);
    await as(worker, KEYS, () => store.archiveWorkflow(id, bea));

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getWorkflow(id, bea));
    assert.equal(back.md, edited, 'the edit made in os-ui must survive the worker archiving the workflow');
    assert.equal(back.archived, true, 'the archive the agent made is kept too');
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test('an agent setting links in the worker keeps a rename made meanwhile in os-ui', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => store.renameKnowledge(id, bea, 'Refund policy'));
    await as(worker, KEYS, () => store.setWorkflowLinks(id, bea, { datasets: ['ds_1'], metrics: [] }));

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getWorkflow(id, bea));
    assert.equal(back.title, 'Refund policy');
    assert.deepEqual(back.links?.datasets, ['ds_1']);
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test('a workflow deleted in os-ui is not brought back by an agent write in the worker', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => {
      store.archiveWorkflow(id, bea);
      store.deleteWorkflow(id, bea);
    });
    assert.equal(os.doc(INDEX, id), undefined, 'the delete reached the mirror');
    await as(worker, KEYS, () => store.setWorkflowLinks(id, bea, { datasets: ['ds_1'], metrics: [] }));
    assert.equal(os.doc(INDEX, id), undefined, 'the worker write must not re-create the deleted workflow');
  } finally {
    os.restore();
    store.__resetStore();
  }
});
