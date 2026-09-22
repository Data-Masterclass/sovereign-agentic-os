/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AirflowConn,
  airflowAuthHeaders,
  airflowHealth,
  listDags,
  getDagRun,
  triggerDag,
  listDagRuns,
  getTaskInstances,
  getTaskLogs,
  getXcom,
  listDatasets,
  getDatasetEvents,
  setDagPaused,
  clearTask,
  AIRFLOW_LOG_MAX,
} from './airflow.ts';

/** A recording fake fetch: captures every request and returns a scripted response. */
function fakeFetch(script: (url: string, init: RequestInit) => { status: number; body?: unknown; text?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => r.text ?? '',
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const SECRET = 'super-secret-token-value';

function bearerConn(fetchImpl: typeof fetch): AirflowConn {
  return { baseUrl: 'https://airflow.example.com', authType: 'bearer', secret: SECRET, fetchImpl };
}
function basicConn(fetchImpl: typeof fetch): AirflowConn {
  return { baseUrl: 'https://airflow.example.com/', authType: 'basic', username: 'svc', secret: SECRET, fetchImpl };
}

test('bearer auth injects a Bearer header (and never a Basic one)', () => {
  const h = airflowAuthHeaders({ baseUrl: 'x', authType: 'bearer', secret: SECRET, fetchImpl: fetch });
  assert.equal(h.authorization, `Bearer ${SECRET}`);
});

test('basic auth injects a base64(user:pass) header', () => {
  const h = airflowAuthHeaders({ baseUrl: 'x', authType: 'basic', username: 'svc', secret: 'pw', fetchImpl: fetch });
  assert.equal(h.authorization, `Basic ${Buffer.from('svc:pw', 'utf8').toString('base64')}`);
});

test('no secret ⇒ no Authorization header (honest fail, never a broken header)', () => {
  const h = airflowAuthHeaders({ baseUrl: 'x', authType: 'bearer', fetchImpl: fetch });
  assert.equal(h.authorization, undefined);
});

test('listDags builds the correct v2 URL and injects the Bearer auth', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { dags: [{ dag_id: 'etl', is_paused: false, description: 'd' }] } }));
  const r = await listDags(bearerConn(f.impl));
  assert.ok(r.ok && r.data[0].dagId === 'etl');
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/dags?limit=100');
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, `Bearer ${SECRET}`);
});

test('reads fall back to v1 when v2 returns 404 (both path shapes supported)', async () => {
  const f = fakeFetch((url) =>
    url.includes('/api/v2/') ? { status: 404 } : { status: 200, body: { dags: [{ dag_id: 'v1dag' }] } },
  );
  const r = await listDags(basicConn(f.impl));
  assert.ok(r.ok && r.data[0].dagId === 'v1dag');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].url.includes('/api/v2/dags'));
  assert.ok(f.calls[1].url.includes('/api/v1/dags'));
});

test('getDagRun builds the run URL and shapes state/logicalDate', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { dag_id: 'etl', dag_run_id: 'run1', state: 'success', logical_date: '2026-01-01T00:00:00Z' } }));
  const r = await getDagRun(bearerConn(f.impl), 'etl', 'run1');
  assert.ok(r.ok && r.data.state === 'success');
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/dags/etl/dagRuns/run1');
});

test('triggerDag POSTs {conf, logical_date} to the dagRuns collection', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { dag_id: 'etl', dag_run_id: 'run9', state: 'queued' } }));
  const r = await triggerDag(bearerConn(f.impl), 'etl', { rows: 5 }, '2026-02-02T00:00:00Z');
  assert.ok(r.ok && r.data.dagRunId === 'run9');
  const call = f.calls[0];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url, 'https://airflow.example.com/api/v2/dags/etl/dagRuns');
  assert.deepEqual(JSON.parse(String(call.init.body)), { conf: { rows: 5 }, logical_date: '2026-02-02T00:00:00Z' });
});

test('triggerDag defaults conf to {} and omits logical_date when not given', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { dag_id: 'etl', dag_run_id: 'r', state: 'queued' } }));
  await triggerDag(bearerConn(f.impl), 'etl');
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { conf: {} });
});

// ------------------------------------------------- observe (Read) ---------------

test('listDagRuns builds the runs URL with limit + state filter', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { dag_runs: [{ dag_id: 'etl', dag_run_id: 'r1', state: 'failed' }] } }));
  const r = await listDagRuns(bearerConn(f.impl), 'etl', { limit: 5, state: 'failed' });
  assert.ok(r.ok && r.data[0].state === 'failed');
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/dags/etl/dagRuns?limit=5&state=failed');
  assert.equal(f.calls[0].init.method, 'GET');
});

test('listDagRuns defaults limit and omits state when not given', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { dag_runs: [] } }));
  await listDagRuns(bearerConn(f.impl), 'etl');
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/dags/etl/dagRuns?limit=25');
});

test('getTaskInstances builds the taskInstances URL and shapes rows', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { task_instances: [{ task_id: 'extract', state: 'success', try_number: 1 }] } }));
  const r = await getTaskInstances(bearerConn(f.impl), 'etl', 'r1');
  assert.ok(r.ok && r.data[0].taskId === 'extract' && r.data[0].tryNumber === 1);
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/dags/etl/dagRuns/r1/taskInstances');
});

test('getTaskLogs GETs the logs/{tryNumber} URL as text and passes it through', async () => {
  const f = fakeFetch(() => ({ status: 200, text: 'line1\nline2' }));
  const r = await getTaskLogs(bearerConn(f.impl), 'etl', 'r1', 'extract', { tryNumber: 2 });
  assert.ok(r.ok && r.data.text === 'line1\nline2' && r.data.truncated === false);
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/dags/etl/dagRuns/r1/taskInstances/extract/logs/2');
});

test('getTaskLogs defaults tryNumber to 1 and truncates huge logs to AIRFLOW_LOG_MAX', async () => {
  const big = 'x'.repeat(AIRFLOW_LOG_MAX + 500);
  const f = fakeFetch(() => ({ status: 200, text: big }));
  const r = await getTaskLogs(bearerConn(f.impl), 'etl', 'r1', 'extract');
  assert.ok(r.ok && r.data.truncated === true && r.data.text.length === AIRFLOW_LOG_MAX);
  assert.ok(f.calls[0].url.endsWith('/logs/1'));
});

test('getXcom reads return_value by default and shapes {key,value}', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { key: 'return_value', value: { rows: 42 } } }));
  const r = await getXcom(bearerConn(f.impl), 'etl', 'r1', 'load');
  assert.ok(r.ok && (r.data.value as { rows: number }).rows === 42);
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/dags/etl/dagRuns/r1/taskInstances/load/xcomEntries/return_value');
});

test('listDatasets tries v2 "assets" first', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { assets: [{ id: 1, uri: 's3://bucket/x' }] } }));
  const r = await listDatasets(bearerConn(f.impl));
  assert.ok(r.ok && r.data[0].uri === 's3://bucket/x');
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/assets?limit=50');
});

test('listDatasets falls back to "datasets" when "assets" is 404 on both versions', async () => {
  const f = fakeFetch((url) =>
    url.includes('/assets') ? { status: 404 } : { status: 200, body: { datasets: [{ id: 7, uri: 'ds://y' }] } },
  );
  const r = await listDatasets(bearerConn(f.impl));
  assert.ok(r.ok && r.data[0].id === 7);
  // assets tried on v2+v1 (both 404), then datasets on v2.
  assert.ok(f.calls.some((c) => c.url.includes('/api/v2/datasets')));
});

test('getDatasetEvents builds the events URL and shapes source dag/run', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { asset_events: [{ asset_id: 3, asset_uri: 'a://z', source_dag_id: 'producer', source_run_id: 'pr1', timestamp: 't' }] } }));
  const r = await getDatasetEvents(bearerConn(f.impl));
  assert.ok(r.ok && r.data[0].sourceDagId === 'producer' && r.data[0].datasetUri === 'a://z');
  assert.equal(f.calls[0].url, 'https://airflow.example.com/api/v2/assets/events?limit=50');
});

// --------------------------------------------- control (Write) ------------------

test('setDagPaused PATCHes {is_paused:true} to /dags/{dagId}', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { dag_id: 'etl', is_paused: true } }));
  const r = await setDagPaused(bearerConn(f.impl), 'etl', true);
  assert.ok(r.ok && r.data.isPaused === true);
  const call = f.calls[0];
  assert.equal(call.init.method, 'PATCH');
  assert.equal(call.url, 'https://airflow.example.com/api/v2/dags/etl');
  assert.deepEqual(JSON.parse(String(call.init.body)), { is_paused: true });
  assert.equal((call.init.headers as Record<string, string>).authorization, `Bearer ${SECRET}`);
});

test('setDagPaused(false) unpauses via {is_paused:false}', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { dag_id: 'etl', is_paused: false } }));
  await setDagPaused(bearerConn(f.impl), 'etl', false);
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { is_paused: false });
});

test('clearTask POSTs a real (dry_run:false) clear with run id + scoping', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { task_instances: [{ task_id: 'a' }, { task_id: 'b' }] } }));
  const r = await clearTask(bearerConn(f.impl), 'etl', 'r1', { taskIds: ['a', 'b'], onlyFailed: true });
  assert.ok(r.ok && r.data.cleared === 2);
  const call = f.calls[0];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url, 'https://airflow.example.com/api/v2/dags/etl/clearTaskInstances');
  assert.deepEqual(JSON.parse(String(call.init.body)), { dry_run: false, dag_run_id: 'r1', task_ids: ['a', 'b'], only_failed: true });
});

test('control writes fall back to v1 on a v2 404 (both path shapes)', async () => {
  const f = fakeFetch((url) => (url.includes('/api/v2/') ? { status: 404 } : { status: 200, body: { dag_id: 'etl', is_paused: true } }));
  const r = await setDagPaused(basicConn(f.impl), 'etl', true);
  assert.ok(r.ok);
  assert.ok(f.calls[0].url.includes('/api/v2/dags/etl'));
  assert.ok(f.calls[1].url.includes('/api/v1/dags/etl'));
});

test('a control write never leaks the secret into its failure reason', async () => {
  const f = fakeFetch(() => ({ status: 403 }));
  const r = await setDagPaused(bearerConn(f.impl), 'etl', true);
  assert.ok(!r.ok);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('the secret NEVER appears in any read result (no leak)', async () => {
  const f = fakeFetch(() => ({ status: 401 }));
  const r = await listDags(bearerConn(f.impl));
  assert.ok(!r.ok);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'the secret must not leak into the failure reason');
});

test('a network error degrades to an honest { ok:false, reason } (never throws)', async () => {
  const impl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const r = await listDags(bearerConn(impl));
  assert.deepEqual(r, { ok: false, reason: 'unreachable' });
});

test('health probes the unauth endpoint and reports reachable on any HTTP answer', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { metadatabase: { status: 'healthy' }, scheduler: { status: 'healthy' } } }));
  const h = await airflowHealth(bearerConn(f.impl));
  assert.ok(h.connected);
  assert.ok(h.detail?.includes('metadatabase healthy'));
  // The health probe must NOT carry the credential.
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
  assert.ok(f.calls[0].url.endsWith('/api/v2/monitor/health'));
});
