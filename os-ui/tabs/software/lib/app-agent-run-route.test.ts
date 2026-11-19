/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An app starts only the agent systems it was granted
 * USER STORY: As the owner of an app I grant it one agent in Choose Context → Agents. When the
 *             app calls `os.agents.run`, it can start that agent and no other, and when I remove
 *             the grant (or delete the app) the next call is refused with a reason that says so,
 *             just as `os.data.query` is narrowed to the app's granted datasets.
 * ARCHITECTURE:
 *   - Drives the REAL run route (`app/api/agents/systems/[id]/run`) with a REAL minted app intent,
 *     so the guard, the intent's app slug and the grant check run exactly as in production. The
 *     session, the agent-system store, the run queue and the app lookup are mocked at the module
 *     seam; `enqueueRun` records whether a run was filed, which is the effect that must not
 *     happen on a refusal.
 *   - The OS UI's own call (no app headers) is unchanged: the user's own run rights stay the
 *     authority there.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const USER = { id: 'amir', name: 'Amir', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' };

mock.module('@core/kernel/auth', {
  namedExports: { requireUser: async () => USER, currentUser: async () => USER },
});

const SYSTEM = { system: { name: 'Invoice triage', domain: 'sales' }, agents: [], grants: { tools: [] } };
mock.module('@tabs/agents/lib/store', {
  namedExports: {
    getSystemForRun: () => ({ system: SYSTEM }),
    setRunning: () => ({ running: false }),
    clearActivity: () => {},
  },
});
mock.module('@tabs/agents/lib/build/os-tools', { namedExports: { unmappedGrantNames: () => [] } });

let enqueued: string[] = [];
mock.module('@tabs/agents/lib/build/run-jobs-server', {
  namedExports: {
    runJobStore: async () => ({ get: async () => null }),
    enqueueRun: async (job: { runId: string; systemId: string }) => {
      enqueued.push(job.systemId);
      return { status: 'queued' };
    },
  },
});
mock.module('@tabs/agents/lib/engine/jobs', {
  namedExports: {
    isTerminalEvent: () => true,
    // The run finishes at once: one terminal `done` row.
    tailRunEvents: async function* () {
      yield { seq: 1, event: 'done', data: { report: 'ok' } };
    },
  },
});

type FakeApp = { slug: string; name: string; agents: { id: string; access: 'read-only' }[] };
let APPS: FakeApp[] = [];
mock.module('@tabs/software/lib/apps', {
  namedExports: {
    getAppBySlugForUser: async (slug: string) => APPS.find((a) => a.slug === slug) ?? null,
  },
});

const { mintAppIntent, APP_INTENT_HEADER, APP_ORIGIN_HEADER } = await import('@core/kernel/app-intent');
const { POST } = await import('../../../app/api/agents/systems/[id]/run/route.ts');

function runRequest(systemId: string, headers: Record<string, string>) {
  const req = new Request(`http://os.local/api/agents/systems/${systemId}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify({ prompt: 'Triage the new invoices' }),
  });
  return POST(req, { params: Promise.resolve({ id: systemId }) });
}

const fromApp = (slug: string) => ({
  [APP_ORIGIN_HEADER]: 'app',
  [APP_INTENT_HEADER]: mintAppIntent({ userId: USER.id, appSlug: slug, scopes: ['agent-run'] }),
});

beforeEach(() => {
  enqueued = [];
  APPS = [{ slug: 'invoices', name: 'Invoices', agents: [{ id: 'sys_granted', access: 'read-only' }] }];
});

test('an app starts the agent system it was granted', async () => {
  const res = await runRequest('sys_granted', fromApp('invoices'));
  assert.notEqual(res.status, 403);
  assert.deepEqual(enqueued, ['sys_granted']);
});

test('an app cannot start an agent system it was not granted, and nothing is queued', async () => {
  const res = await runRequest('sys_other', fromApp('invoices'));
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /the app 'Invoices' was not granted the agent system sys_other/);
  assert.match(body.error, /Choose Context/);
  assert.deepEqual(enqueued, []);
});

test('after the grant is removed, the next run from the app is refused', async () => {
  assert.notEqual((await runRequest('sys_granted', fromApp('invoices'))).status, 403);
  APPS[0].agents = [];
  const res = await runRequest('sys_granted', fromApp('invoices'));
  assert.equal(res.status, 403);
  assert.deepEqual(enqueued, ['sys_granted'], 'only the run made while it was granted was queued');
});

test('a run from an app that was deleted is refused with a reason that says so', async () => {
  APPS = [];
  const res = await runRequest('sys_granted', fromApp('invoices'));
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { error: string }).error, /no longer exists/);
  assert.deepEqual(enqueued, []);
});

test('the OS UI’s own Run (no app headers) is unchanged', async () => {
  const res = await runRequest('sys_other', {});
  assert.notEqual(res.status, 403);
  assert.deepEqual(enqueued, ['sys_other']);
});
