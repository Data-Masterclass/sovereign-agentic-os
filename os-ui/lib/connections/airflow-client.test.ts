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
} from './airflow.ts';

/** A recording fake fetch: captures every request and returns a scripted response. */
function fakeFetch(script: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
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
