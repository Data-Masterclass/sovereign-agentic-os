/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Files → Drive sync, per connection, scoped per domain.
 * USER STORY: As a drive owner or a domain builder I want to see, per connected drive, the last sync and its
 *             result, what it imported, how far behind it is, whether it is paused or needs reconnecting —
 *             and I never want another domain's drive on my screen, or a Dagster outage shown as zeros.
 * ARCHITECTURE: the readers are injected (`sources.ts`); Dagster is the recorded `core/infra/dagster.ts`
 *   (its real-container proof is `tests/monitoring/drive-sync.int.test.ts`). Twins: a row of another
 *   domain's drive handed to the panel anyway is dropped; Dagster down → schedule null + unavailable,
 *   counts of runs absent, never 0; never-synced → lag null, not 0.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const real = async (m: string): Promise<Record<string, unknown>> => ({ ...(await import(m)) });
let dagsterDown = false;
mock.module('@core/infra/dagster', {
  namedExports: {
    ...(await real('@core/infra/dagster')),
    nextTick: async (name: string) => dagsterDown ? { ok: false, error: 'timeout after 4000ms' } : { ok: true, data: { name, cron: '*/15 * * * *', timezone: 'UTC', status: 'RUNNING', nextTickAt: '2026-11-22T12:15:00.000Z' } },
    runsByTags: async () => dagsterDown ? { ok: false, error: 'timeout after 4000ms' } : { ok: true, data: [{ runId: 'run1', status: 'SUCCESS', jobName: 'os_files_drive_sync', startedAt: '2026-11-22T11:45:00.000Z', endedAt: '2026-11-22T11:46:00.000Z', tags: {}, assetSelection: [] }] },
  },
});
mock.module('@core/adapters/opensearch/index-stats', { namedExports: { ...(await real('@core/adapters/opensearch/index-stats')), unitRowStats: async () => ({ ok: true, at: '', value: new Map() }) } });

const { registerMonitoringSources } = await import('./sources');
const { filesView } = await import('./files-panel');

const now = Date.parse('2026-11-22T12:00:00Z');
const run = (at: string, ok = true, extra = {}) => ({ at, endedAt: at, durationMs: 1200, trigger: 'schedule' as const, ok, added: 2, changed: 1, unchanged: 7, ...(ok ? {} : { error: 'Microsoft Graph answered 503.' }), ...extra });
const row = (o: Record<string, unknown>) => ({ id: 'src_x', provider: 'onedrive' as const, label: 'OneDrive', domain: 'sales', owner: 'ada', mode: 'copy' as const, connectionId: 'conn_x', connectionHealth: 'healthy' as const, imported: 10, initialDone: true, createdAt: '2026-11-01T00:00:00Z', paused: null, runs: [run('2026-11-22T11:46:00Z')], ...o });
let drives: ReturnType<typeof row>[] = [];
registerMonitoringSources({
  agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(),
  files: async () => [],
  // A careless reader: hands over EVERYTHING regardless of who asks.
  driveSources: async () => drives,
});
const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;
const bob = { id: 'bob', name: 'Bob', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'builder' } as never;
const admin = { id: 'root', name: 'Root', domains: ['sales', 'hr'], allDomains: ['sales', 'hr'], activeDomain: null, role: 'admin' } as never;
beforeEach(() => { dagsterDown = false; drives = [row({}), row({ id: 'src_hr', domain: 'hr', owner: 'bea', label: 'HR drive' }), row({ id: 'src_b', owner: 'bob', label: 'Bob drive' })]; });

test('per connection: last sync and result, counts, lag, files imported', async () => {
  const v = await filesView(ada, now);
  const d = v.drives.connections.find((x) => x.id === 'src_x')!;
  assert.equal(d.state, 'ok');
  assert.deepEqual({ ok: d.lastSync!.ok, added: d.lastSync!.added, changed: d.lastSync!.changed, unchanged: d.lastSync!.unchanged, trigger: d.lastSync!.trigger }, { ok: true, added: 2, changed: 1, unchanged: 7, trigger: 'schedule' });
  assert.equal(d.lagMinutes, 14);
  assert.equal(d.filesImported, 10);
});

test('scope: a creator sees only their own drive; the other domain\'s and a colleague\'s never reach the payload', async () => {
  const v = await filesView(ada, now);
  assert.deepEqual(v.drives.connections.map((x) => x.id), ['src_x']);
  assert.ok(!JSON.stringify(v).includes('HR drive') && !JSON.stringify(v).includes('src_hr'));
});

test('scope: a builder sees own + their domain, not another domain; an admin sees all', async () => {
  assert.deepEqual((await filesView(bob, now)).drives.connections.map((x) => x.id).sort(), ['src_b', 'src_x']);
  assert.deepEqual((await filesView(admin, now)).drives.connections.map((x) => x.id).sort(), ['src_b', 'src_hr', 'src_x']);
});

test('a failed last sync shows its error text and sorts first; the failing-run count is of the kept history', async () => {
  drives = [row({ runs: [run('2026-11-22T11:00:00Z'), run('2026-11-22T11:46:00Z', false)] }), row({ id: 'src_ok', owner: 'ada' })];
  const v = await filesView(ada, now);
  assert.equal(v.drives.connections[0].id, 'src_x');
  assert.equal(v.drives.connections[0].state, 'failed');
  assert.equal(v.drives.connections[0].lastSync!.error, 'Microsoft Graph answered 503.');
  assert.equal(v.drives.connections[0].failedRuns, 1);
  assert.equal(v.drives.summary!.failing, 1);
});

test('paused is shown with its reason; needs-reconnect is shown', async () => {
  drives = [row({ paused: { reason: 'the owner is deactivated', at: '2026-11-21T00:00:00Z' } }), row({ id: 'src_r', connectionHealth: 'needs-reconnect' })];
  const v = await filesView(ada, now);
  const by = Object.fromEntries(v.drives.connections.map((x) => [x.id, x]));
  assert.equal(by.src_x.state, 'paused');
  assert.equal(by.src_x.paused!.reason, 'the owner is deactivated');
  assert.equal(by.src_r.state, 'needs_reconnect');
  assert.equal(v.drives.summary!.paused, 1);
  assert.equal(v.drives.summary!.needsReconnect, 1);
});

test('lag over the threshold is "lagging"; a drive that never synced has lag null (twin: not 0)', async () => {
  drives = [row({ runs: [run('2026-11-22T07:00:00Z')] }), row({ id: 'src_new', runs: [], initialDone: false, createdAt: '2026-11-22T11:50:00Z' })];
  const v = await filesView(ada, now);
  const by = Object.fromEntries(v.drives.connections.map((x) => [x.id, x]));
  assert.equal(by.src_x.state, 'lagging');
  assert.equal(by.src_x.lagMinutes, 300);
  assert.equal(by.src_new.state, 'never_synced');
  assert.equal(by.src_new.lagMinutes, null);
  assert.equal(by.src_new.lastSync, null);
});

test('Dagster down: the schedule and its last run are unavailable (null + reason), never "no runs"; the OS-recorded syncs still show', async () => {
  dagsterDown = true;
  const v = await filesView(ada, now);
  assert.equal(v.drives.sources.dagster.state, 'unavailable');
  assert.match((v.drives.sources.dagster as { reason: string }).reason, /timeout/);
  assert.equal(v.drives.schedule, null);
  assert.equal(v.drives.lastDagsterRun, null);
  assert.equal(v.drives.connections[0].lastSync!.added, 2);
});

test('Dagster up: the schedule, next tick and last Dagster run are the ones Dagster reports', async () => {
  const v = await filesView(ada, now);
  assert.equal(v.drives.sources.dagster.state, 'live');
  assert.equal(v.drives.schedule!.cron, '*/15 * * * *');
  assert.equal(v.drives.schedule!.nextTickAt, '2026-11-22T12:15:00.000Z');
  assert.equal(v.drives.lastDagsterRun!.status, 'SUCCESS');
});

test('the drive reader not registered or failing is "unavailable" with the reason — an empty list is never "no drives"', async () => {
  registerMonitoringSources({ agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(), files: async () => [] });
  const v = await filesView(ada, now);
  assert.equal(v.drives.sources.drives.state, 'unavailable');
  assert.equal(v.drives.summary, null);
  registerMonitoringSources({ agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(), files: async () => [], driveSources: async () => { throw new Error('sources store not loaded'); } });
  const w = await filesView(ada, now);
  assert.match((w.drives.sources.drives as { reason: string }).reason, /not loaded/);
});

test('what is not available upstream is said: removals are not propagated by the sync', async () => {
  const v = await filesView(ada, now);
  assert.ok(v.notUpstream.some((n) => /removed|deleted/i.test(n.panel + n.reason)));
});
