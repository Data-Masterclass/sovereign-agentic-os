/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The Agents tab's Run files its job as a `manual` trigger
 * USER STORY: As an operator reading `run_jobs` I want a run started from the Agents tab to say
 *             `trigger: manual`, beside `schedule` and `api`, so the three doors are told apart.
 * ARCHITECTURE:
 *   - Drives the REAL run route (`app/api/agents/systems/[id]/run`) with the session, the store and
 *     the queue mocked at the module seam (the pattern of tabs/software/lib/app-agent-run-route.test.ts);
 *     `enqueueRun` records the job input the route filed.
 */
import { test, mock } from 'node:test';
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

const filed: { kind: string; input: Record<string, unknown> }[] = [];
mock.module('@tabs/agents/lib/build/run-jobs-server', {
  namedExports: {
    runJobStore: async () => ({ get: async () => null }),
    enqueueRun: async (job: { kind: string; input: Record<string, unknown> }) => {
      filed.push({ kind: job.kind, input: job.input });
      return { status: 'queued' };
    },
  },
});
mock.module('@tabs/agents/lib/engine/jobs', {
  namedExports: {
    isTerminalEvent: () => true,
    tailRunEvents: async function* () {
      yield { seq: 1, event: 'done', data: { report: 'ok' } };
    },
  },
});

const { POST } = await import('../../../../app/api/agents/systems/[id]/run/route.ts');

test('a Run from the Agents tab files input.trigger === "manual"', async () => {
  const req = new Request('http://os.local/api/agents/systems/sys_a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ prompt: 'Triage the new invoices' }),
  });
  const res = await POST(req, { params: Promise.resolve({ id: 'sys_a' }) });
  assert.notEqual(res.status, 403);
  assert.equal(filed.length, 1, 'the job is filed before the route answers');
  assert.equal(filed[0].kind, 'start');
  assert.equal(filed[0].input.trigger, 'manual');
  assert.equal(filed[0].input.prompt, 'Triage the new invoices');
});
