/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Owner alerts for a connected drive: sync failed, lag over the threshold, needs reconnect.
 * USER STORY: As a drive owner I want one in-app alert per incident, addressed to me and to nobody else.
 * ARCHITECTURE: the real `evaluateDriveHealth` over the real sources store (fake OpenSearch) with the
 *   real notification store; the connection health is the Connections store's `health`, injected.
 *   Twins: a healthy drive raises nothing; the same incident is not re-sent on the next evaluation;
 *   a paused source raises no lag alert.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCluster } from '@core/infra/two-process-fixture';

const c = await import('@tabs/files/lib/connectors');
const { evaluateDriveHealth } = await import('@tabs/files/lib/drive-health-server');
const notif = await import('@core/notifications/store');

let cluster: ReturnType<typeof fakeCluster>;
beforeEach(() => { cluster = fakeCluster(); c.__resetConnectors(); notif.__resetNotifications(); });
afterEach(() => cluster.restore());

const now = Date.parse('2026-11-22T12:00:00Z');
const okRun = (at: string) => ({ at, endedAt: at, durationMs: 1, trigger: 'schedule' as const, ok: true, added: 0, changed: 0, unchanged: 1 });
async function src(owner: string, patch: Partial<import('@tabs/files/lib/connectors').ConnectorSource> = {}) {
  await c.requireSourcesLoaded();
  const s = c.addSource({ provider: 'onedrive', label: `${owner} drive`, scope: 'drive', target: 'root', mode: 'copy', owner, domain: 'sales', connectionId: `conn_${owner}` });
  Object.assign(s, { runs: [okRun('2026-11-22T11:50:00Z')] }, patch);
  c.saveSource(s);
  return s;
}
const healthy = async () => 'healthy' as const;
const inbox = (u: string) => notif.listNotifications(u).filter((n) => /drive/i.test(n.title));

test('a failed sync alerts its OWNER only, with the error text', async () => {
  await src('ada', { runs: [okRun('2026-11-22T11:00:00Z'), { ...okRun('2026-11-22T11:50:00Z'), ok: false, error: 'Microsoft Graph answered 503.' }] });
  await src('bea');
  const r = await evaluateDriveHealth({ connectionHealth: healthy, nowMs: now });
  assert.equal(r.fired, 1);
  assert.equal(inbox('ada').length, 1);
  assert.match(inbox('ada')[0].body, /503/);
  assert.equal(inbox('bea').length, 0, 'a healthy drive of someone else raises nothing');
});

test('lag over the threshold alerts the owner; twin: under the threshold, nothing', async () => {
  await src('ada', { runs: [okRun('2026-11-22T08:00:00Z')] });
  await src('bea', { runs: [okRun('2026-11-22T11:30:00Z')] });
  await evaluateDriveHealth({ connectionHealth: healthy, nowMs: now });
  assert.equal(inbox('ada').length, 1);
  assert.match(inbox('ada')[0].body, /not synced|behind|lag/i);
  assert.equal(inbox('bea').length, 0);
});

test('needs-reconnect alerts the owner of that connection only', async () => {
  await src('ada');
  await src('bea');
  await evaluateDriveHealth({ connectionHealth: async (id) => (id === 'conn_ada' ? 'needs-reconnect' : 'healthy'), nowMs: now });
  assert.equal(inbox('ada').length, 1);
  assert.match(inbox('ada')[0].body, /reconnect/i);
  assert.equal(inbox('bea').length, 0);
});

test('an incident is sent once: the next evaluation is silent; after recovery a new incident alerts again', async () => {
  await src('ada');
  const bad = async () => 'needs-reconnect' as const;
  await evaluateDriveHealth({ connectionHealth: bad, nowMs: now });
  await evaluateDriveHealth({ connectionHealth: bad, nowMs: now + 60_000 });
  assert.equal(inbox('ada').length, 1);
  await evaluateDriveHealth({ connectionHealth: healthy, nowMs: now + 120_000 });
  await evaluateDriveHealth({ connectionHealth: bad, nowMs: now + 180_000 });
  assert.equal(inbox('ada').length, 2);
});

test('a PAUSED source raises no lag alert (the pause is its own explanation)', async () => {
  await src('ada', { runs: [okRun('2026-11-22T01:00:00Z')], paused: { reason: 'the owner is deactivated', at: '2026-11-22T02:00:00Z' } });
  const r = await evaluateDriveHealth({ connectionHealth: healthy, nowMs: now });
  assert.equal(r.fired, 0);
});

test('when the connection health cannot be read, no reconnect alert is invented and the others still work', async () => {
  await src('ada', { runs: [okRun('2026-11-22T08:00:00Z')] });
  await evaluateDriveHealth({ connectionHealth: async () => 'unknown', nowMs: now });
  assert.equal(inbox('ada').length, 1);
  assert.doesNotMatch(inbox('ada')[0].body, /reconnect/i);
});
