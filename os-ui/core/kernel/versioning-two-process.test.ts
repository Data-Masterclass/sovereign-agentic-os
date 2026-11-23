/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Version history written by two processes never overwrites itself
 * USER STORY: As a user whose note was edited in the web app AND by an agent run in the worker, I
 *             find both snapshots in its history — neither replaced the other.
 * ARCHITECTURE:
 *   - Two simulated processes (`two-process-fixture.ts`) over one fake OpenSearch, the REAL
 *     `versionLog`: each picks the next number from its own history, so both pick v1; the
 *     create-only write moves the second to v2 instead of overwriting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster, proc, as } from '@core/infra/two-process-fixture';
import { versionLog } from '@core/kernel/versioning';

const log = versionLog('two-proc-test');
const KEYS = [Symbol.for('soa.versions.two-proc-test')];

test('the worker and os-ui both record "v1" of one artifact — both snapshots survive, as v1 and v2', async () => {
  const os = fakeCluster();
  log.__reset();
  const web = proc();
  const worker = proc(true);
  try {
    await as(web, KEYS, () => log.ensureHydrated());
    await as(worker, KEYS, () => log.ensureHydrated());
    await as(worker, KEYS, () => { log.record('pk_1', 'agent', { md: 'by the agent' }, 'agent edit'); });
    const mine = await as(web, KEYS, () => log.record('pk_1', 'nova', { md: 'by the person' }, 'edit'));
    const docs = [1, 2].map((n) => os.doc('os-versions-two-proc-test', `pk_1:${n}`) as { summary?: string } | undefined);
    assert.deepEqual(docs.map((d) => d?.summary), ['agent edit', 'edit'], 'v1 is the agent\'s, v2 the person\'s — nothing overwritten');
    assert.equal(mine.version, 2, 'the web app\'s own copy moved to the free number');
    assert.equal(await as(web, KEYS, () => log.latest('pk_1')), 2);
  } finally {
    os.restore();
    log.__reset();
  }
});
