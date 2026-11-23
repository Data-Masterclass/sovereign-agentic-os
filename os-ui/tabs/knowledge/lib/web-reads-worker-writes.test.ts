/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The web app lists what an agent run saved in the run worker — without a restart
 * USER STORY: As the owner of an agent run that reported "Saved to My knowledge /results" I open
 *             Knowledge → My knowledge and find the note there (dev, Nov 2026: the note was in
 *             OpenSearch but os-ui, hydrated once at boot, never listed it).
 * ARCHITECTURE:
 *   - Two simulated processes (`two-process-fixture.ts`) over one fake OpenSearch: os-ui with the
 *     refresh it switches on at boot ('changes' mode, `instrumentation.ts`) and the run worker.
 *     The REAL personal-notes store; the reads are the ones the tabs' routes make.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as } from '@core/infra/two-process-fixture';
import { later } from '@core/infra/worker-refresh-suite';
import * as notes from '@tabs/knowledge/lib/personal-store';

const nova = { id: 'nova-admin', domains: ['finance'], role: 'admin' as const };
const NOTE_KEYS = [Symbol.for('soa.knowledge.personal-store'), Symbol.for('soa.versions.personal-knowledge')];

test('a note the WORKER saves (an agent output) is listed in the web app\'s My knowledge without a restart', async () => {
  const os = fakeCluster();
  notes.__resetStore();
  const web = proc();
  const worker = proc(true);
  try {
    // os-ui boots, hydrates, switches the refresh on; the worker boots too.
    await as(web, NOTE_KEYS, async () => {
      await notes.ensureHydrated();
      assert.equal(notes.enableMirrorRefresh(), true);
    });
    await as(worker, NOTE_KEYS, async () => {
      notes.enableMirrorRefresh();
      await notes.ensureHydrated();
    });
    // The agent run saves its declared knowledge output — in the worker.
    const id = await as(worker, NOTE_KEYS, () =>
      notes.createPersonalKnowledge(nova, { title: 'Result — run', md: '## Summary', folder: '/results', sourceKey: 'agent-output:sys:run:k' }).id,
    );
    // Before: os-ui had no way to see it. Now one refresh later it lists it, in /results.
    later();
    const mine = await as(web, NOTE_KEYS, async () => {
      await notes.ensureHydrated(); // the route's hydrate seam
      return notes.listPersonalKnowledge(nova).mine;
    });
    assert.deepEqual(mine.map((e) => [e.id, e.folder]), [[id, '/results']]);
  } finally {
    os.restore();
    notes.__resetStore();
  }
});
