/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    An agent's write to a personal note in the worker never overwrites a newer edit made in the web app
 * USER STORY: As a creator I edit my note in the Knowledge tab while an agent (running in the
 *             worker pod) moves or archives it. After the agent finishes and os-ui restarts, my
 *             text is still there — and so is what the agent did. A note I deleted stays deleted.
 * ARCHITECTURE:
 *   - Two simulated processes over one fake OpenSearch, through the REAL store
 *     (`core/infra/two-process-fixture.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as, type Proc } from '@core/infra/two-process-fixture';
import * as store from '@tabs/knowledge/lib/personal-store';

const KEYS = [Symbol.for('soa.knowledge.personal-store')];
const INDEX = 'os-personal-knowledge';
const bea = { id: 'bea', domains: ['sales'], role: 'creator' as const };

async function scenario() {
  const os = fakeCluster();
  store.__resetStore();
  const web = proc();
  const id = await as(web, KEYS, async () => {
    await store.ensureHydrated();
    return store.createPersonalKnowledge(bea, { title: 'Supplier notes', md: 'Acme ships on Tuesdays.' }).id;
  });
  const worker = proc(true);
  await as(worker, KEYS, () => store.ensureHydrated());
  return { os, web, worker, id };
}

async function restart(): Promise<Proc> {
  const fresh = proc();
  await as(fresh, KEYS, () => store.ensureHydrated());
  return fresh;
}

test('an agent archiving a note in the worker keeps the text edited meanwhile in os-ui', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => store.updatePersonalKnowledge(id, bea, { md: 'Acme ships on Tuesdays and Fridays.' }));
    await as(worker, KEYS, () => store.archivePersonalKnowledge(id, bea));

    const rebooted = await restart();
    const back = await as(rebooted, KEYS, () => store.getPersonalKnowledge(id, bea));
    assert.equal(back.md, 'Acme ships on Tuesdays and Fridays.', 'the edit made in os-ui must survive the worker archiving the note');
    assert.equal(back.archived, true);
  } finally {
    os.restore();
    store.__resetStore();
  }
});

test('a note deleted in os-ui is not brought back by an agent write in the worker', async () => {
  const { os, web, worker, id } = await scenario();
  try {
    await as(web, KEYS, () => store.deletePersonalKnowledge(id, bea));
    await as(worker, KEYS, () => store.moveKnowledge(id, bea, '/Suppliers'));
    assert.equal(os.doc(INDEX, id), undefined, 'the worker write must not re-create the deleted note');
  } finally {
    os.restore();
    store.__resetStore();
  }
});
