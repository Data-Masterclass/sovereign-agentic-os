/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every connector sync run is kept on its source, and the scheduled pass respects pause states.
 * USER STORY: As a drive owner I want to see what each sync did and why one failed; as an admin I want a
 *             scheduled pass never to sync a paused source or lift its pause.
 * ARCHITECTURE: the real `runConnectorSync` / `runDueConnectorSyncs` / store sink over the fake OpenSearch
 *   (`two-process-fixture`) and the teaching-flow mock drive. Twins: failed run recorded AND rethrown;
 *   history bounded; paused source untouched; another owner's source is synced as ITS owner.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster } from '@core/infra/two-process-fixture';

process.env.OS_OFFLINE_MOCK = 'allow';

const c = await import('@tabs/files/lib/connectors');
const srv = await import('@tabs/files/lib/connectors-server');
const files = await import('@tabs/files/lib/store');
const { MAX_SYNC_RUNS } = await import('@tabs/files/lib/drive-sync-health');

let cluster: ReturnType<typeof fakeCluster>;
beforeEach(() => { cluster = fakeCluster(); c.__resetConnectors(); files.__resetStore(); });
afterEach(() => cluster.restore());

const entitled = { liveOwner: async () => ({ domains: ['sales'] }), token: async () => null };
async function newSource(owner = 'aborek', domain = 'sales', provider: 'onedrive' | 'google-drive' = 'onedrive') {
  await c.requireSourcesLoaded();
  return c.addSource({ provider, label: 'D', scope: 'drive', target: 'root', mode: 'copy', owner, domain, connectionId: `conn_${owner}` });
}

test('a successful run is recorded with trigger, counts and duration — and persisted', async () => {
  const s = await newSource();
  const r = await srv.runConnectorSync(s.id, 'aborek', entitled);
  const rec = c.getSource(s.id)!.runs!;
  assert.equal(rec.length, 1);
  assert.equal(rec[0].ok, true);
  assert.equal(rec[0].trigger, 'manual');
  assert.equal(rec[0].added, r.added);
  assert.equal(rec[0].changed, r.updated);
  assert.equal(rec[0].unchanged, r.unchanged);
  assert.ok(rec[0].durationMs >= 0 && Date.parse(rec[0].at) > 0);
  assert.equal((cluster.doc('os-files-sources', s.id) as { runs: unknown[] }).runs.length, 1, 'in the existing store (the mirror), not a new database');
});

test('the scheduled trigger is recorded as such; the counts of a second run are the incremental ones', async () => {
  const s = await newSource();
  await srv.runConnectorSync(s.id, 'aborek', entitled);
  await srv.runConnectorSync(s.id, 'aborek', entitled, 'schedule');
  const rec = c.getSource(s.id)!.runs!;
  assert.deepEqual(rec.map((x) => x.trigger), ['manual', 'schedule']);
  assert.equal(rec[1].added + rec[1].changed + rec[1].unchanged, 1);
});

test('a FAILED run keeps its error text AND still throws (twin: never swallowed, never green)', async () => {
  const s = await newSource();
  await assert.rejects(srv.runConnectorSync(s.id, 'aborek', { liveOwner: entitled.liveOwner, token: async () => { throw new Error('Graph answered 503'); } }, 'schedule'), /Graph answered 503/);
  const rec = c.getSource(s.id)!.runs!;
  assert.equal(rec.length, 1);
  assert.equal(rec[0].ok, false);
  assert.match(rec[0].error!, /Graph answered 503/);
  assert.equal(c.getSource(s.id)!.initialDone, false, 'the failed run did not advance the source');
});

test('the history is bounded', async () => {
  const s = await newSource();
  for (let i = 0; i < MAX_SYNC_RUNS + 3; i++) await srv.runConnectorSync(s.id, 'aborek', entitled);
  assert.equal(c.getSource(s.id)!.runs!.length, MAX_SYNC_RUNS);
});

test('a refusal because the owner lost entitlement pauses the source and is NOT recorded as a sync run', async () => {
  const s = await newSource();
  await assert.rejects(srv.runConnectorSync(s.id, 'aborek', { ...entitled, liveOwner: async () => null }));
  assert.equal(c.getSource(s.id)!.runs ?? [] .length, 0);
  assert.ok(c.getSource(s.id)!.paused);
});

// ------------------------------------------------------------------ the scheduled pass --

test('the scheduled pass syncs every unpaused source as ITS owner, with the schedule trigger', async () => {
  const a = await newSource('aborek', 'sales');
  const b = await newSource('bea', 'hr', 'google-drive');
  const seen: string[] = [];
  const out = await srv.runDueConnectorSyncs((src) => ({
    liveOwner: async (id) => { seen.push(`owner:${id}`); return { domains: [src.domain] }; },
    token: async () => { seen.push(`token:${src.owner}:${src.connectionId}`); return null; },
  }));
  assert.deepEqual(out.map((o) => [o.sourceId, o.status]).sort(), [[a.id, 'ok'], [b.id, 'ok']].sort());
  assert.ok(seen.includes('token:bea:conn_bea') && seen.includes('owner:bea'));
  assert.equal(c.getSource(a.id)!.runs![0].trigger, 'schedule');
  assert.equal(c.getSource(b.id)!.runs![0].trigger, 'schedule');
});

test('a PAUSED source is not synced by the scheduled pass, its pause is not lifted, and no run is recorded (twin: the unpaused one is)', async () => {
  const paused = await newSource('aborek', 'sales');
  const live = await newSource('bea', 'sales');
  c.getSource(paused.id)!.paused = { reason: 'the owner is deactivated', at: '2026-11-20T00:00:00Z' };
  let tokenFor: string[] = [];
  const out = await srv.runDueConnectorSyncs((src) => ({ liveOwner: async () => ({ domains: ['sales'] }), token: async () => { tokenFor.push(src.id); return null; } }));
  assert.deepEqual(tokenFor, [live.id], 'nothing was read for the paused source');
  assert.equal(out.find((o) => o.sourceId === paused.id)!.status, 'skipped');
  assert.match(out.find((o) => o.sourceId === paused.id)!.reason!, /paused/);
  assert.ok(c.getSource(paused.id)!.paused, 'still paused');
  assert.equal((c.getSource(paused.id)!.runs ?? []).length, 0);
  assert.equal(c.getSource(live.id)!.runs!.length, 1);
});

test('one failing source does not stop the pass: it is reported failed with its error, the others still sync', async () => {
  const a = await newSource('aborek', 'sales');
  const b = await newSource('bea', 'sales');
  const out = await srv.runDueConnectorSyncs((src) => ({ liveOwner: async () => ({ domains: ['sales'] }), token: async () => { if (src.id === a.id) throw new Error('token store down'); return null; } }));
  assert.equal(out.find((o) => o.sourceId === a.id)!.status, 'failed');
  assert.match(out.find((o) => o.sourceId === a.id)!.reason!, /token store down/);
  assert.equal(out.find((o) => o.sourceId === b.id)!.status, 'ok');
});

test('while the source store is not loaded the pass refuses (typed), it does not report "nothing to do"', async () => {
  await newSource();
  cluster.mode = 'down';
  const { as, proc } = await import('@core/infra/two-process-fixture');
  await as(proc(), [Symbol.for('soa.files.connectors.state')], async () => {
    await assert.rejects(srv.runDueConnectorSyncs(() => entitled), (e: Error & { code?: string }) => e.code === 'store_not_loaded');
  });
});
