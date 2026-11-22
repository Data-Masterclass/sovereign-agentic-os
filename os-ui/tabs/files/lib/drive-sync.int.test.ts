/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The scheduled Drive sync end to end on REAL components: the OS's own Dagster job on
 *             dagster-webserver 1.13.31, the real sync path and live Google Drive client against a provider
 *             stub at the HTTP boundary, the real OpenSearch source store, and the Monitoring panel.
 * USER STORY: As a drive owner I want Dagster to sync my drive as me on a schedule, a failure to show as a failed
 *             Dagster run AND on my Monitoring panel with the provider's error, and a paused drive to stay untouched.
 * ARCHITECTURE:
 *   - tests/monitoring/up.sh (MON_IT=1): Dagster runs `images/extensions/dagster/os_files_sync.py` as mounted; its op
 *     POSTs to the os-ui stand-in hosted below on MON_OSUI_PORT with the run token (the TokenReview/OPA gate in
 *     `route.ts` is not part of this harness; `_handlers.ts` tickWith — the code behind it — is the real one).
 *   - The Drive stub speaks Google Drive v3 `files.list` (`GOOGLE_API_BASE_URL` points the real client at it).
 *   - Negative twins: the provider answering 500 → the Dagster run FAILS with the text, the source records a failed
 *     run, the panel shows it; a paused source's drive is never asked; os-ui down → the Dagster run fails and no
 *     sync is recorded; Dagster down → the panel says unavailable and has no schedule (never zero).
 *   - Run: MON_IT=1 node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test tabs/files/lib/drive-sync.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const on = process.env.MON_IT === '1';
const OS = process.env.MON_OS_URL ?? 'http://127.0.0.1:19200';
const DAGSTER = process.env.MON_DAGSTER_URL ?? 'http://127.0.0.1:13570';
const OSUI_PORT = Number(process.env.MON_OSUI_PORT ?? 18700);
// The harness location is `-f defs.py`, so its name is `defs.py` (the chart's is `sovereign`).
const deps = { url: DAGSTER, location: 'defs.py', repository: '__repository__', timeoutMs: 10_000 };
const RUN_TOKEN = 'harness-run-token-not-a-secret';
process.env.OPENSEARCH_URL = OS;
process.env.DAGSTER_URL = DAGSTER;
process.env.OS_OFFLINE_MOCK = 'refuse'; // the fake drive must never be the answer

type Drive = { mode: 'ok' | 'fail500'; seen: string[] };
const drive: Drive = { mode: 'ok', seen: [] };
let driveSrv: Server;
let osuiSrv: Server | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function listen(srv: Server, port: number, host: string): Promise<number> {
  await new Promise<void>((res, rej) => { srv.once('error', rej); srv.listen(port, host, res); });
  return (srv.address() as { port: number }).port;
}

type Mods = {
  c: typeof import('@tabs/files/lib/connectors');
  tickWith: typeof import('../../../app/api/runtime/files-sync/_handlers').tickWith;
  dagster: typeof import('@core/infra/dagster');
  filesView: typeof import('@tabs/monitoring/lib/panels/files-panel').filesView;
  reg: typeof import('@tabs/monitoring/lib/panels/sources');
};
let m: Mods;
const tokens: Record<string, string> = { ada: 'oauth-ada-not-a-secret', bea: 'oauth-bea-not-a-secret' };
const live = { ada: { domains: ['sales'] }, bea: { domains: ['hr'] } } as Record<string, { domains: string[] }>;

function startOsUi(): Promise<number> {
  osuiSrv = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/runtime/files-sync') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${RUN_TOKEN}`) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthenticated"}'); return; }
    const r = await m.tickWith((src) => ({ liveOwner: async (id) => live[id] ?? null, token: async () => tokens[src.owner] ?? null }));
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
  });
  return listen(osuiSrv, OSUI_PORT, '0.0.0.0');
}

before(async () => {
  if (!on) return;
  await fetch(`${OS}/os-files-sources`, { method: 'DELETE' }); // a fresh store: no source of an earlier run
  driveSrv = createServer((req, res) => {
    drive.seen.push(String(req.headers.authorization ?? ''));
    if (drive.mode === 'fail500') { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"backend error"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ files: [
      { id: 'g1', name: 'plan.pdf', mimeType: 'application/pdf', modifiedTime: '2026-11-20T09:00:00Z', md5Checksum: 'aaa', webViewLink: 'https://drive.example/g1' },
      { id: 'g2', name: 'notes.txt', mimeType: 'text/plain', modifiedTime: '2026-11-20T09:00:00Z', md5Checksum: 'bbb', webViewLink: 'https://drive.example/g2' },
    ] }));
  });
  const port = await listen(driveSrv, 0, '127.0.0.1');
  process.env.GOOGLE_API_BASE_URL = `http://127.0.0.1:${port}`;
  m = {
    c: await import('@tabs/files/lib/connectors'),
    tickWith: (await import('../../../app/api/runtime/files-sync/_handlers')).tickWith,
    dagster: await import('@core/infra/dagster'),
    filesView: (await import('@tabs/monitoring/lib/panels/files-panel')).filesView,
    reg: await import('@tabs/monitoring/lib/panels/sources'),
  };
  await startOsUi();
});
after(async () => { driveSrv?.close(); osuiSrv?.close(); });

async function runJob(): Promise<{ status: string; runId: string }> {
  const l = await m.dagster.launchRun({ jobName: 'os_files_drive_sync', tags: { 'os/job': 'files_drive_sync', 'os/trigger': 'schedule' } }, deps);
  assert.ok(l.ok, JSON.stringify(l));
  for (let i = 0; i < 90; i++) {
    const r = await m.dagster.run(l.data.runId, deps);
    assert.ok(r.ok, JSON.stringify(r));
    if (['SUCCESS', 'FAILURE', 'CANCELED'].includes(r.data.status)) return { status: r.data.status, runId: l.data.runId };
    await sleep(1000);
  }
  throw new Error('the Dagster run did not finish in 90 s');
}
async function storedRuns(id: string): Promise<{ ok: boolean; error?: string; trigger: string; added: number }[]> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${OS}/os-files-sources/_doc/${id}`);
    if (r.ok) { const d = (await r.json()) as { _source: { runs?: never[] } }; if (d._source.runs?.length) return d._source.runs; }
    await sleep(500);
  }
  return [];
}

const ada = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' } as never;
const root = { id: 'root', name: 'Root', domains: ['sales', 'hr'], allDomains: ['sales', 'hr'], activeDomain: null, role: 'admin' } as never;
let adaSrc = '';
let beaSrc = '';

test('the schedule is defined by Dagster under the names the panel reads', { skip: !on }, async () => {
  await m.c.requireSourcesLoaded();
  const t = await m.dagster.nextTick('os_files_drive_sync_schedule', deps);
  assert.ok(t.ok, JSON.stringify(t));
  assert.equal(t.data.cron, '*/15 * * * *');
  assert.equal(t.data.status, 'RUNNING', 'the harness has the run token, so the schedule starts running');
});

test('a Dagster run syncs each unpaused drive as its owner through the real Drive client; a paused drive is never asked', { skip: !on }, async () => {
  adaSrc = m.c.addSource({ provider: 'google-drive', label: 'Ada Drive', scope: 'drive', target: 'root', mode: 'reference', owner: 'ada', domain: 'sales', connectionId: 'conn_ada' }).id;
  const bea = m.c.addSource({ provider: 'google-drive', label: 'HR Drive', scope: 'drive', target: 'root', mode: 'reference', owner: 'bea', domain: 'hr', connectionId: 'conn_bea' });
  beaSrc = bea.id;
  m.c.getSource(beaSrc)!.paused = { reason: 'the owner is deactivated', at: '2026-11-21T00:00:00Z' };
  m.c.saveSource(m.c.getSource(beaSrc)!);
  drive.seen = [];
  const r = await runJob();
  assert.equal(r.status, 'SUCCESS');
  assert.deepEqual(drive.seen, [`Bearer ${tokens.ada}`], 'the provider saw only ada\'s own token, once; bea (paused) was never asked');
  const runs = await storedRuns(adaSrc);
  assert.equal(runs.length, 1);
  assert.deepEqual({ ok: runs[0].ok, trigger: runs[0].trigger, added: runs[0].added }, { ok: true, trigger: 'schedule', added: 2 }, 'recorded in the real OpenSearch source store');
  assert.equal((m.c.getSource(beaSrc)!.runs ?? []).length, 0);
  assert.ok(m.c.getSource(beaSrc)!.paused, 'the pause was not lifted');
});

test('the panel shows the run, the Dagster schedule and last run, and keeps the other domain out', { skip: !on }, async () => {
  m.reg.registerMonitoringSources({
    agentSystems: async () => [], datasets: async () => [], latestTests: async () => new Map(), assetKeys: async () => new Map(), files: async () => [],
    driveSources: async () => m.c.listSources().map((s) => ({ id: s.id, provider: s.provider, label: s.label, domain: s.domain, owner: s.owner, mode: s.mode, connectionId: s.connectionId, connectionHealth: 'healthy' as const, imported: Object.values(s.imported ?? {}).filter((e) => e.hash !== '').length, initialDone: s.initialDone, createdAt: s.createdAt, paused: s.paused ?? null, runs: s.runs ?? [] })),
  });
  const v = await m.filesView(ada, Date.now(), deps);
  assert.equal(v.drives.sources.dagster.state, 'live');
  assert.equal(v.drives.schedule!.name, 'os_files_drive_sync_schedule');
  assert.equal(v.drives.lastDagsterRun!.status, 'SUCCESS');
  assert.deepEqual(v.drives.connections.map((c) => c.id), [adaSrc], 'bea\'s HR drive is invisible to ada');
  const d = v.drives.connections[0];
  assert.equal(d.state, 'ok');
  assert.equal(d.lastSync!.trigger, 'schedule');
  assert.equal(d.filesImported, 2);
  const adm = await m.filesView(root, Date.now(), deps);
  assert.equal(adm.drives.connections.find((c) => c.id === beaSrc)!.state, 'paused');
});

test('twin: the provider answers 500 — the Dagster run FAILS with the reason, the source records the failed run, the panel shows it', { skip: !on }, async () => {
  drive.mode = 'fail500';
  const r = await runJob();
  assert.equal(r.status, 'FAILURE');
  const runs = await storedRuns(adaSrc);
  await sleep(500);
  const last = m.c.getSource(adaSrc)!.runs!.at(-1)!;
  assert.equal(last.ok, false);
  assert.match(last.error!, /Drive API answered 500/);
  assert.ok(runs.length >= 1);
  const v = await m.filesView(ada, Date.now(), deps);
  assert.equal(v.drives.connections[0].state, 'failed');
  assert.match(v.drives.connections[0].lastSync!.error!, /Drive API answered 500/);
  assert.equal(v.drives.lastDagsterRun!.status, 'FAILURE');
  drive.mode = 'ok';
});

test('twin: os-ui unreachable — the Dagster run fails and nothing was synced or recorded', { skip: !on }, async () => {
  const before = m.c.getSource(adaSrc)!.runs!.length;
  await new Promise<void>((res) => osuiSrv!.close(() => res()));
  osuiSrv = null;
  const r = await runJob();
  assert.equal(r.status, 'FAILURE');
  assert.equal(m.c.getSource(adaSrc)!.runs!.length, before);
  await startOsUi();
});

test('twin: Dagster down — the panel says unavailable, has no schedule and no Dagster run (never "0 runs"); the recorded syncs still show', { skip: !on }, async () => {
  const v = await m.filesView(ada, Date.now(), { url: 'http://127.0.0.1:1', timeoutMs: 1500 });
  assert.equal(v.drives.sources.dagster.state, 'unavailable');
  assert.equal(v.drives.schedule, null);
  assert.equal(v.drives.lastDagsterRun, null);
  assert.ok(v.drives.connections[0].lastSync);
});
