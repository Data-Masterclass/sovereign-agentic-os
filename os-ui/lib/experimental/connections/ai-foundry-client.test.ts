/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AiFoundryConn,
  aiFoundryHealth,
  aiFoundryListModels,
  aiFoundryListDeployments,
  aiFoundryGetDeployment,
} from './ai-foundry.ts';

function fakeFetch(
  script: (url: string, init: RequestInit) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const r = script(u, init ?? {});
    const headers = new Headers(r.headers ?? {});
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const TOKEN = 'eyJfake-aml-token-xxx';
function conn(fetchImpl: typeof fetch): AiFoundryConn {
  return { baseUrl: 'https://eastus.api.azureml.ms', token: TOKEN, fetchImpl };
}

test('listModels injects the Bearer, shapes rows (value[] shape) + truncated flag', async () => {
  const f = fakeFetch((url, init) => {
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
    assert.ok(url.includes('/modelregistry/'));
    return { status: 200, body: { value: [{ name: 'gpt-mini', version: '3', id: 'azureml://models/gpt-mini/3' }], nextLink: 'next' } };
  });
  const r = await aiFoundryListModels(conn(f.impl));
  assert.ok(r.ok && r.data[0].name === 'gpt-mini' && r.data[0].version === '3' && r.truncated === true);
});

test('listModels tolerates a bare-array response shape (honest shaping, no fabrication)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: [{ name: 'm-bare', version: '1', id: 'id1' }] }));
  const r = await aiFoundryListModels(conn(f.impl));
  assert.ok(r.ok && r.data[0].name === 'm-bare');
});

test('listDeployments shapes name/model/provisioningState from properties', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [{ name: 'd1', properties: { model: 'gpt-mini:3', provisioningState: 'Succeeded' } }] } }));
  const r = await aiFoundryListDeployments(conn(f.impl));
  assert.ok(r.ok && r.data[0].name === 'd1' && r.data[0].model === 'gpt-mini:3' && r.data[0].provisioningState === 'Succeeded');
});

test('getDeployment needs a name (validated before the network)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await aiFoundryGetDeployment(conn(f.impl), '');
  assert.ok(!r.ok && /name/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('getDeployment shapes one deployment', async () => {
  const f = fakeFetch((url) => {
    assert.ok(url.includes('/onlineDeployments/d1'));
    return { status: 200, body: { name: 'd1', properties: { model: 'gpt-mini:3', provisioningState: 'Succeeded' } } };
  });
  const r = await aiFoundryGetDeployment(conn(f.impl), 'd1');
  assert.ok(r.ok && r.data.name === 'd1' && r.data.provisioningState === 'Succeeded');
});

test('no endpoint ⇒ honest refusal, no network call', async () => {
  const f = fakeFetch(() => ({ status: 200, body: {} }));
  const r = await aiFoundryListModels({ baseUrl: '', token: TOKEN, fetchImpl: f.impl });
  assert.ok(!r.ok && /endpoint/.test(r.reason));
  assert.equal(f.calls.length, 0);
});

test('unseeable deployment → not_found (404 mapped honestly, never fabricated)', async () => {
  const f = fakeFetch(() => ({ status: 404 }));
  const r = await aiFoundryGetDeployment(conn(f.impl), 'missing');
  assert.ok(!r.ok && r.reason === 'not_found');
});

test('health: models 2xx → connected; 401 → honest not-connected (never fake green)', async () => {
  const up = fakeFetch(() => ({ status: 200, body: { value: [] } }));
  const h = await aiFoundryHealth(conn(up.impl));
  assert.ok(h.connected && /reachable/.test(h.detail ?? ''));
  const bad = fakeFetch(() => ({ status: 401 }));
  const h2 = await aiFoundryHealth(conn(bad.impl));
  assert.ok(!h2.connected && /unauthorized/.test(h2.reason ?? ''));
});

test('rate limit: 429 + retry-after → honest rate-limited reason (no hammer)', async () => {
  const f = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '9' } }));
  const r = await aiFoundryListModels(conn(f.impl));
  assert.ok(!r.ok && /rate-limited/.test(r.reason) && /9/.test(r.reason));
});

test('honest failure: a thrown network error degrades to { ok:false, unreachable }', async () => {
  const impl = (async () => { throw new Error('boom'); }) as typeof fetch;
  const r = await aiFoundryListModels({ baseUrl: 'https://eastus.api.azureml.ms', token: TOKEN, fetchImpl: impl });
  assert.ok(!r.ok && r.reason === 'unreachable');
});

test('no token ⇒ no Authorization header sent (honest auth failure)', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { value: [] } }));
  await aiFoundryListModels({ baseUrl: 'https://eastus.api.azureml.ms', fetchImpl: f.impl });
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, undefined);
});
