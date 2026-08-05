/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Route tests for the 0.6.64 GRANT-SCOPED ask surface (POST /api/data/ask).
 *
 * 0.6.63 denied any app origin outright; 0.6.64 instead NARROWS the free-form NL→SQL
 * context to (user access ∩ the app's granted datasets). We prove:
 *   1. GRANTED-ONLY scoping — an app origin only ever sees its granted datasets in the
 *      LLM context (the ungranted one the USER can see is filtered out). Because that
 *      same filtered list is the ONLY schema the model is shown, it is also the only set
 *      the generated SQL can target.
 *   2. ZERO grants → honest 403 ("no dataset grants …").
 *   3. NON-APP request → completely unchanged (the full listAskable set reaches the model).
 *
 * The env + apps-cache + auth mocking mirrors app-origin.test.ts; the LLM / governed
 * query / trace are mocked so the test is offline and deterministic. `runAsk` is mocked to
 * a pass-through that CAPTURES the `datasets` it was handed — that captured set is exactly
 * the prompt-context AND SQL-target scope, so asserting on it proves both.
 */

process.env.OS_APPS_DOMAIN = 'apps.example.com';
process.env.OS_PUBLIC_URL = 'https://os.example.com';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@/lib/core/auth', {
  namedExports: {
    requireUser: async () => {
      if (!ACTING) {
        const e = new Error('Not authenticated') as Error & { status?: number };
        e.status = 401;
        throw e;
      }
      return ACTING;
    },
    currentUser: async () => ACTING,
  },
});

// The FULL canView-scoped set the session user can see: a granted dataset + an ungranted
// one. `ensureHydrated` is what requirePrincipal awaits — a no-op here.
const ALL_ASKABLE = [
  { id: 'ds_zpco1s6n7y', name: 'Northpeak Products', domain: 'sales', tier: 'dataset', fqn: 'iceberg.personal_own.gold_products', description: '', columns: [] },
  { id: 'ds_other', name: 'Other Dataset', domain: 'sales', tier: 'dataset', fqn: 'iceberg.personal_own.gold_other', description: '', columns: [] },
];
mock.module('@/lib/data/store', {
  namedExports: {
    ensureHydrated: async () => {},
    listAskable: () => ALL_ASKABLE,
  },
});

// Capture the datasets runAsk actually receives — that IS the model's prompt context AND
// the only tables the generated SQL can target. Returns a benign no_dataset outcome.
let seenDatasetIds: string[] | null = null;
mock.module('@/lib/data/ask', {
  namedExports: {
    runAsk: async (input: { datasets: { id: string }[] }) => {
      seenDatasetIds = input.datasets.map((d) => d.id);
      return { ok: false, kind: 'no_dataset', message: 'none' };
    },
  },
});

mock.module('@/lib/assistant/runtime', {
  namedExports: { liteLlmCaller: () => async () => ({ content: '' }) },
});
mock.module('@/lib/infra/governed', {
  namedExports: {
    queryRun: async () => ({ columns: [], rows: [], rowCount: 0 }),
    trace: async () => ({ ok: true }),
  },
});
mock.module('@/lib/models/roles', {
  namedExports: {
    roleModel: () => 'test-model',
    standardFirstEscalationEnabled: () => false,
  },
});
mock.module('@/lib/data/store-fqn', {
  namedExports: { readPrincipalFor: (_sql: string, u: { id: string }) => u.id },
});

const { createApp, writeThroughApp, __resetAppsCache } = await import('./apps.ts');

beforeEach(() => {
  __resetAppsCache();
  seenDatasetIds = null;
});

async function loadRoute() {
  return import(`../../app/api/data/ask/route.ts?${Math.random()}`);
}

const ask = (headers: Record<string, string> = {}) =>
  new Request('http://os.example.com/api/data/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ question: 'how many products?' }),
  });

/** Seed an app owned by ACTING granted EXACTLY one dataset (ds_zpco1s6n7y). */
async function seedGrantedApp() {
  ACTING = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder' };
  const app = await createApp(ACTING, { name: 'Northpeak Products', template: 'sovereign-app' });
  app.grants.data = [{ id: 'ds_zpco1s6n7y', access: 'read-only' }];
  writeThroughApp(app);
  return app;
}

test('ask from an app origin sees ONLY the app-granted datasets (not the full canView set)', async () => {
  const app = await seedGrantedApp();
  const route = await loadRoute();
  const res = await route.POST(ask({ referer: `https://os.example.com/api/apps/runtime/${app.slug}` }));
  // 200 no_dataset (benign) — the point is WHICH datasets reached runAsk.
  assert.equal(res.status, 200);
  assert.deepEqual(seenDatasetIds, ['ds_zpco1s6n7y'], 'only the granted dataset is in scope; ds_other is filtered out');
});

test('ask from an app origin with ZERO dataset grants is an honest 403 (never runs)', async () => {
  ACTING = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder' };
  const app = await createApp(ACTING, { name: 'Empty Grants', template: 'sovereign-app' });
  app.grants.data = [];
  writeThroughApp(app);
  const route = await loadRoute();
  const res = await route.POST(ask({ referer: `https://os.example.com/api/apps/runtime/${app.slug}` }));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /no dataset grants/i);
  assert.match(body.error, /Software tab/);
  assert.equal(seenDatasetIds, null, 'runAsk is never reached for a zero-grant app');
});

test('ask from an app origin whose slug is UNKNOWN fails closed (403, empty grant set)', async () => {
  ACTING = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder' };
  const route = await loadRoute();
  const res = await route.POST(ask({ referer: 'https://os.example.com/api/apps/runtime/ghost-app' }));
  assert.equal(res.status, 403);
  assert.equal(seenDatasetIds, null, 'an unknown app slug never reaches the ask');
});

test('a NON-app (OS UI) request is completely unchanged — the full canView set reaches the model', async () => {
  ACTING = { id: 'own', name: 'Owner', domains: ['sales'], role: 'builder' };
  const route = await loadRoute();
  const res = await route.POST(ask()); // no app Origin/Referer → not an app
  assert.equal(res.status, 200);
  assert.deepEqual(seenDatasetIds, ['ds_zpco1s6n7y', 'ds_other'], 'non-app ask spans the whole canView set');
});
