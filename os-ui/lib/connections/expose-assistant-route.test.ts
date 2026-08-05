/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Route tests for the Expose assistant (POST /api/connections/[id]/expose-assistant) —
 * lakehouse-expose-experience.md Phase C. The assistant only PROPOSES; every card is
 * VALIDATED SERVER-SIDE against the real snapshot/domains before it can render an Apply.
 * We prove:
 *   1. a REAL selection (tables in the snapshot) becomes a `selection` card;
 *   2. a HALLUCINATED table is refused — no card, an honest note in the prose;
 *   3. a HALLUCINATED domain (or unknown table) refuses the `exposure` card;
 *   4. a VALID exposure (real domains + real tables) becomes an `exposure` card;
 *   5. `classify` always passes through;
 *   6. a 503 (no model) / 402 (cost cap) from the model surfaces plainly (status passthrough);
 *   7. a non-admin is refused (403) — admin-gated like the mutations it proposes.
 *
 * The auth + all grounding libs + the ONE model call are mocked so the test is offline and
 * deterministic; only the route's own validation logic is under test.
 */

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: {
    requireUser: async () => {
      if (!ACTING) { const e = new Error('Not authenticated') as Error & { status?: number }; e.status = 401; throw e; }
      return ACTING;
    },
    currentUser: async () => ACTING,
  },
});

mock.module('@/lib/connections/store', {
  namedExports: {
    getConnectionForUser: async () => ({ id: 'conn_1', template: 'warehouse', warehouse: { catalog: 'glue' }, endpoint: 'glue' }),
  },
});

// The REAL grounding: two snapshot tables, one seeded taxonomy, two domains, no sets.
mock.module('@/lib/connections/warehouse/catalog-snapshot', {
  namedExports: {
    getCatalogSnapshot: async () => ({
      connectionId: 'conn_1', catalog: 'glue', status: 'stale', takenAt: '2026-08-05T00:00:00Z',
      tables: [{ schema: 'sales', table: 'orders' }, { schema: 'sales', table: 'customers' }],
      prevDiff: { added: [], removed: [] }, detail: '',
    }),
  },
});
mock.module('@/lib/connections/warehouse/catalog-classification', {
  namedExports: {
    getMergedClassification: async () => ({
      taxonomy: [{ id: 'orders', name: 'Orders' }, { id: 'unsorted', name: 'Unsorted' }],
      seed: 'starter',
      placements: { 'sales.orders': { category: 'orders', source: 'ai' }, 'sales.customers': { category: 'unsorted', source: 'unsorted' } },
      lastRunDetail: '1 classified, 1 unsorted.',
    }),
  },
});
mock.module('@/lib/connections/exposures', {
  namedExports: {
    listExposureSets: async () => [],
    entityActionKey: (e: string) => String(e ?? '').trim().toLowerCase(),
  },
});
mock.module('@/lib/platform-admin/domains', {
  namedExports: {
    listDomains: () => [{ id: 'commerce', name: 'Commerce', archived: false }, { id: 'finance', name: 'Finance', archived: false }],
  },
});

// The ONE model call — steered per test via MODEL_REPLY (a raw string the route parses) or an
// error to throw (503/402 passthrough).
let MODEL_REPLY = '';
let MODEL_THROW: (Error & { status?: number }) | null = null;
mock.module('@/lib/assistant/complete', {
  namedExports: {
    assistantComplete: async () => {
      if (MODEL_THROW) throw MODEL_THROW;
      return { content: MODEL_REPLY, model: 'test-model' };
    },
  },
});

const { POST } = await import('../../app/api/connections/[id]/expose-assistant/route.ts');

type Body = { message?: string; suggestions?: { classify?: boolean; selection?: { tables: string[] }; exposure?: { domains: string[]; tables: string[]; mode?: string; tier?: string; name?: string } }; error?: string };

async function ask(reply: string): Promise<{ status: number; body: Body }> {
  MODEL_REPLY = reply;
  MODEL_THROW = null;
  const req = new Request('http://x/api/connections/conn_1/expose-assistant', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'catalog', messages: [{ role: 'user', content: 'go' }] }),
  });
  const res = await POST(req, { params: Promise.resolve({ id: 'conn_1' }) });
  return { status: res.status, body: (await res.json()) as Body };
}

beforeEach(() => { ACTING = { id: 'ada', name: 'Ada', domains: ['commerce'], role: 'admin' }; });

test('a real selection becomes a selection card', async () => {
  const { status, body } = await ask(JSON.stringify({ message: 'ok', selection: { tables: ['sales.orders'] } }));
  assert.equal(status, 200);
  assert.deepEqual(body.suggestions?.selection?.tables, ['sales.orders']);
});

test('a hallucinated table is refused — no selection card, honest note', async () => {
  const { status, body } = await ask(JSON.stringify({ message: 'sure', selection: { tables: ['sales.ghost'] } }));
  assert.equal(status, 200);
  assert.equal(body.suggestions?.selection, undefined);
  assert.match(body.message ?? '', /can’t offer|not in this catalog snapshot/i);
});

test('a mix keeps only the real tables', async () => {
  const { body } = await ask(JSON.stringify({ message: 'ok', selection: { tables: ['sales.orders', 'sales.ghost'] } }));
  assert.deepEqual(body.suggestions?.selection?.tables, ['sales.orders']);
});

test('a valid exposure (real domains + tables) becomes an exposure card', async () => {
  const { body } = await ask(JSON.stringify({ message: 'ok', exposure: { name: 'S', domains: ['commerce'], mode: 'live', tier: 'gold', tables: ['sales.orders'] } }));
  assert.deepEqual(body.suggestions?.exposure?.domains, ['commerce']);
  assert.deepEqual(body.suggestions?.exposure?.tables, ['sales.orders']);
  assert.equal(body.suggestions?.exposure?.mode, 'live');
  assert.equal(body.suggestions?.exposure?.tier, 'gold');
});

test('a hallucinated domain refuses the exposure card', async () => {
  const { body } = await ask(JSON.stringify({ message: 'ok', exposure: { domains: ['marketing'], tables: ['sales.orders'] } }));
  assert.equal(body.suggestions?.exposure, undefined);
  assert.match(body.message ?? '', /do not exist|can’t offer/i);
});

test('an exposure with no real tables is refused', async () => {
  const { body } = await ask(JSON.stringify({ message: 'ok', exposure: { domains: ['commerce'], tables: ['sales.ghost'] } }));
  assert.equal(body.suggestions?.exposure, undefined);
});

test('classify passes through', async () => {
  const { body } = await ask(JSON.stringify({ message: 'organizing', classify: true }));
  assert.equal(body.suggestions?.classify, true);
});

test('503 (no model) surfaces plainly with its status', async () => {
  MODEL_THROW = Object.assign(new Error('No assistant model is configured'), { status: 503 });
  const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ stage: 'catalog', messages: [{ role: 'user', content: 'go' }] }) });
  const res = await POST(req, { params: Promise.resolve({ id: 'conn_1' }) });
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as Body).error ?? '', /No assistant model/);
});

test('402 (cost cap) surfaces plainly with its status', async () => {
  MODEL_THROW = Object.assign(new Error('Monthly assistant cost cap reached'), { status: 402 });
  const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ stage: 'catalog', messages: [{ role: 'user', content: 'go' }] }) });
  const res = await POST(req, { params: Promise.resolve({ id: 'conn_1' }) });
  assert.equal(res.status, 402);
});

test('a non-admin is refused (403)', async () => {
  ACTING = { id: 'cara', name: 'Cara', domains: ['commerce'], role: 'creator' };
  const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ stage: 'catalog', messages: [] }) });
  const res = await POST(req, { params: Promise.resolve({ id: 'conn_1' }) });
  assert.equal(res.status, 403);
});
