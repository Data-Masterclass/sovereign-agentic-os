/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    P3(f) — the resume after a decision runs as the RUNNER, re-read live, or is refused
 * USER STORY: As the owner I want the "approver authorises, runner executes" rule pinned: a resume
 *             is refused (typed, stamped on the approval) when the runner was deactivated, lost the
 *             role the tool needs, or left the domain — and it continues as the live runner otherwise.
 * ARCHITECTURE:
 *   - `resumeAfterDecision` with fake deps (loadPrincipal / toolPermitted / resumeRun / markResume);
 *     no server module, no graph.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval, ApprovalResume } from '@core/policy/approvals';
import { resumeAfterDecision, type LivePrincipal, type ResumeDeps } from '@tabs/agents/lib/engine/resume';

const RUN_APPROVAL: Approval = {
  id: 'apr_1',
  kind: 'connection_write',
  title: 'Approval needed: request_promotion',
  detail: '',
  agent: 'os-sys1',
  domain: 'sales',
  requestedBy: 'runner-rae',
  tool: 'request_promotion',
  payload: {},
  approverRole: 'domain_admin',
  scope: 'domain',
  rememberable: false,
  source: 'Agents',
  status: 'approved',
  createdAt: new Date().toISOString(),
  runId: 'run_1',
  threadId: 'run_1',
  interruptKey: 'run_1:c-1',
  systemId: 'sys1',
  node: 'writer',
  runner: { id: 'runner-rae', role: 'builder', domains: ['sales'] },
};

function fakeDeps(live: LivePrincipal | null, permitted = true) {
  const marks: ApprovalResume[] = [];
  const resumed: { runner: LivePrincipal; decision: string }[] = [];
  const deps: ResumeDeps = {
    loadPrincipal: async () => live,
    toolPermitted: () => permitted,
    resumeRun: async ({ runner, decision }) => { resumed.push({ runner, decision }); return { parked: false, reachedEnd: true }; },
    markResume: (_id, r) => { marks.push(r); },
    now: () => '2026-11-13T00:00:00.000Z',
  };
  return { deps, marks, resumed };
}

test('P3(f) the resume runs as the LIVE runner (the role is re-read, not trusted from the snapshot)', async () => {
  const f = fakeDeps({ id: 'runner-rae', name: 'Rae', role: 'domain_admin', domains: ['sales', 'ops'] });
  const out = await resumeAfterDecision(RUN_APPROVAL, 'approve', f.deps);
  assert.equal(out.status, 'done');
  assert.equal(f.resumed.length, 1);
  assert.equal(f.resumed[0].runner.id, 'runner-rae');
  assert.equal(f.resumed[0].runner.role, 'domain_admin', 'the live role, not the snapshot builder');
  assert.equal(f.resumed[0].decision, 'approve');
  assert.deepEqual(f.marks.map((m) => m.status), ['started', 'done']);
});

test('P3(f) refused when the runner was deactivated — nothing resumes, the approval says why', async () => {
  const f = fakeDeps(null);
  const out = await resumeAfterDecision(RUN_APPROVAL, 'approve', f.deps);
  assert.equal(out.status, 'refused');
  assert.equal((out as { code: string }).code, 'runner_unavailable');
  assert.equal(f.resumed.length, 0);
  assert.equal(f.marks[0].status, 'refused');
  assert.equal(f.marks[0].error?.code, 'runner_unavailable');
});

test("P3(f) refused when the runner's live role no longer permits the tool", async () => {
  const f = fakeDeps({ id: 'runner-rae', name: 'Rae', role: 'creator', domains: ['sales'] }, false);
  const out = await resumeAfterDecision(RUN_APPROVAL, 'approve', f.deps);
  assert.equal(out.status, 'refused');
  assert.equal((out as { code: string }).code, 'runner_role_insufficient');
  assert.equal(f.resumed.length, 0);
  assert.match(f.marks[0].error?.reason ?? '', /creator/);
});

test('P3(f) refused when the runner left the domain; a rejection still resumes (the agent gets the typed result)', async () => {
  const left = fakeDeps({ id: 'runner-rae', name: 'Rae', role: 'builder', domains: ['ops'] });
  const out = await resumeAfterDecision(RUN_APPROVAL, 'approve', left.deps);
  assert.equal(out.status, 'refused');
  assert.equal((out as { code: string }).code, 'runner_domain_lost');

  const ok = fakeDeps({ id: 'runner-rae', name: 'Rae', role: 'builder', domains: ['sales'] });
  const rej = await resumeAfterDecision(RUN_APPROVAL, 'reject', ok.deps);
  assert.equal(rej.status, 'done');
  assert.equal(ok.resumed[0].decision, 'reject');
});

test('an approval that carries no run is refused typed; a failing resume is stamped failed, never thrown', async () => {
  const f = fakeDeps({ id: 'runner-rae', name: 'Rae', role: 'builder', domains: ['sales'] });
  const plain = await resumeAfterDecision({ ...RUN_APPROVAL, runId: undefined, systemId: undefined, runner: undefined }, 'approve', f.deps);
  assert.equal(plain.status, 'refused');
  assert.equal((plain as { code: string }).code, 'not_a_run_approval');

  const boom = fakeDeps({ id: 'runner-rae', name: 'Rae', role: 'builder', domains: ['sales'] });
  boom.deps.resumeRun = async () => { const e = new Error('finished'); e.name = 'RunAlreadyFinishedError'; throw e; };
  const out = await resumeAfterDecision(RUN_APPROVAL, 'approve', boom.deps);
  assert.equal(out.status, 'failed');
  assert.equal((out as { code: string }).code, 'RunAlreadyFinishedError');
  assert.equal(boom.marks.at(-1)?.status, 'failed');
});
