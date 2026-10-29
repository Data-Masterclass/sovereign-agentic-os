/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the LiteLLM admin read client.
 *
 * USER STORY: As a maintainer I want proof that a read of the gateway can never
 *             throw into a page, never report a failure as empty data, and never
 *             put the master key anywhere but a server-side Authorization header.
 *
 * ARCHITECTURE:
 *   `fetch` is stubbed per case via `withGateway`, which also pins a known URL
 *   and key and restores all three afterwards, so cases cannot leak into each
 *   other. Every failure mode LiteLLM can present is covered as its own case:
 *   unconfigured, non-2xx, transport error, and a hung request that must abort.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminGet, unwrapRows, liteLlmConfigured } from './litellm-admin.ts';
import { config } from '@core/kernel/config';

type Cfg = { litellmUrl: string; litellmMasterKey: string };

/** Run `fn` with a known gateway URL/key and a stubbed fetch, then restore. */
function withGateway(stub: typeof globalThis.fetch, fn: () => Promise<void>) {
  return async () => {
    const c = config as unknown as Cfg;
    const [u, k, f] = [c.litellmUrl, c.litellmMasterKey, globalThis.fetch];
    c.litellmUrl = 'http://litellm.test';
    c.litellmMasterKey = 'sk-test-master';
    globalThis.fetch = stub;
    try { await fn(); } finally { c.litellmUrl = u; c.litellmMasterKey = k; globalThis.fetch = f; }
  };
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

test('LITELLM-ADMIN: unwraps a bare array', () => {
  assert.deepEqual(unwrapRows<number>([1, 2]), [1, 2]);
});

test('LITELLM-ADMIN: unwraps a {data:[]} envelope', () => {
  assert.deepEqual(unwrapRows<number>({ data: [3] }), [3]);
});

test('LITELLM-ADMIN: unwraps a caller-named envelope key', () => {
  assert.deepEqual(unwrapRows<number>({ keys: [4] }, 'keys'), [4]);
});

test('LITELLM-ADMIN: an unrecognised shape is empty, never an exception', () => {
  assert.deepEqual(unwrapRows<number>({ surprise: 1 }), []);
  assert.deepEqual(unwrapRows<number>(null), []);
});

test('LITELLM-ADMIN: an unconfigured gateway fails without a fetch', async () => {
  const c = config as unknown as Cfg;
  const u = c.litellmUrl;
  c.litellmUrl = '';
  try {
    const r = await adminGet('/model/info');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not configured/);
  } finally { c.litellmUrl = u; }
});

test('LITELLM-ADMIN: sends the master key as a Bearer header and returns data', withGateway(
  async (input, init) => {
    assert.equal(String(input), 'http://litellm.test/model/info');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-test-master');
    assert.equal(init?.cache, 'no-store');
    return json({ data: [{ model_name: 'a' }] });
  },
  async () => {
    const r = await adminGet<{ data: unknown[] }>('/model/info');
    assert.equal(r.ok, true);
    assert.deepEqual((r as { data: { data: unknown[] } }).data.data, [{ model_name: 'a' }]);
  },
));

test('LITELLM-ADMIN: a non-2xx becomes an error result, not a throw', withGateway(
  async () => json({}, 500),
  async () => {
    const r = await adminGet('/team/list');
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, 'HTTP 500');
  },
));

test('LITELLM-ADMIN: a transport failure becomes an error result', withGateway(
  async () => { throw new Error('ECONNREFUSED'); },
  async () => {
    const r = await adminGet('/key/list');
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, 'ECONNREFUSED');
  },
));

test('LITELLM-ADMIN: a hung gateway times out and says so', withGateway(
  (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  }),
  async () => {
    const r = await adminGet('/health/latest', 10);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /timeout after 10ms/);
  },
));

test('LITELLM-ADMIN: configured requires BOTH a url and a key', () => {
  const c = config as unknown as Cfg;
  const [u, k] = [c.litellmUrl, c.litellmMasterKey];
  try {
    c.litellmUrl = 'http://x'; c.litellmMasterKey = '';
    assert.equal(liteLlmConfigured(), false);
    c.litellmMasterKey = 'sk-1';
    assert.equal(liteLlmConfigured(), true);
  } finally { c.litellmUrl = u; c.litellmMasterKey = k; }
});
