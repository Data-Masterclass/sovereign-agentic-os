/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-30 — guardrails as OPA data compiled into the os-data bundle FROM GIT
 * USER STORY: As an operator I want the guardrails OPA enforces to be exactly the files committed in
 *             each domain repository, and a broken or missing OPA to deny, never a mock that allows.
 * ARCHITECTURE:
 *   - `restoreGuardrailsFromGit` runs in the bundle compiler's CAPTURE mode (as every bundled
 *     source does) over real git repositories written by the real knowledge commit path.
 *   - NEGATIVE TWINS: a hard rule held only in the store (not committed) never reaches OPA; a
 *     malformed committed file and a workflow id committed twice refuse the whole source; OPA
 *     unreachable denies (`policy_unreachable`) and the push path reports a failure, no mock.
 *   - The real-OPA proofs are tests/opa/guardrails-bundle.int.test.ts and guardrails.eject.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPA_URL = 'http://127.0.0.1:1'; // nothing listens: OPA unreachable

const { captureOpaWrites } = await import('@core/policy/opa-capture');
const { commitKnowledge, __setKnowledgeGitForTests } = await import('@tabs/knowledge/lib/git/commit');
const { commitSubtree, listTree, readBlob } = await import('@core/infra/git-store');
const GR_PATH = 'knowledge/workflows/bank-submission/guardrails.json';
const { workflowRecord, WF_MD } = await import('@tabs/knowledge/lib/git/fixtures');
const { restoreGuardrailsFromGit, decideGuardrails } = await import('@tabs/knowledge/lib/guardrails-data');
const { applyGuardrails } = await import('@tabs/knowledge/lib/guardrails-apply');
const { parseWorkflow } = await import('@tabs/knowledge/lib/schema');

const actor = { id: 'alex@example.com', name: 'Alex' };

async function repos(records: ReturnType<typeof workflowRecord>[], domain = 'sales'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wp30-guardrails-'));
  __setKnowledgeGitForTests(true);
  const res = await commitKnowledge(domain, actor, { action: 'publish workflow' }, { reposDir: dir, mirror: false, captured: { workflows: records, manual: null } });
  assert.ok(res?.changed, 'the knowledge commit wrote the domain repo');
  return dir;
}

async function captured(reposDir: string) {
  const { result, tree } = await captureOpaWrites({}, () => restoreGuardrailsFromGit({ reposDir }));
  return { result, guardrails: (tree.os_data as Record<string, unknown> | undefined)?.guardrails as Record<string, unknown> | undefined };
}

test('the committed guardrails.json of every domain repo lands at os_data.guardrails[<workflow id>]', async () => {
  const dir = await repos([workflowRecord()]);
  try {
    const { result, guardrails } = await captured(dir);
    assert.equal(result.ok, true, result.detail);
    assert.deepEqual(guardrails, {
      wf_bank: {
        guardrails: [
          { id: 'wr2', level: 'workflow', text: 'Never submit without sign-off' },
          { id: 'sr1', level: 'step', step_id: 'verify', text: 'Error rate < 0.1%' },
        ],
      },
    });
    assert.match(result.detail, /sales@[0-9a-f]{12}/, 'the detail records the commit each domain was read at');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NEGATIVE TWIN: a hard rule only in the store (no committed guardrails.json) is not in the bundle', async () => {
  const soft = WF_MD.replace(/hard: true/g, 'hard: false');
  const dir = await repos([workflowRecord({ md: soft })]);
  try {
    const { result, guardrails } = await captured(dir);
    assert.equal(result.ok, true, result.detail);
    assert.deepEqual(guardrails, {}, 'git has no guardrails.json → OPA has no guardrails for the workflow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NEGATIVE TWIN: a malformed committed guardrails.json refuses the source (complete or nothing)', async () => {
  const dir = await repos([workflowRecord()]);
  try {
    const files = new Map<string, string>();
    for (const e of await listTree('sales', undefined, { reposDir: dir })) {
      if (e.path.startsWith('knowledge/')) files.set(e.path, await readBlob('sales', undefined, e.path, { reposDir: dir }));
    }
    assert.ok(files.has(GR_PATH), 'the fixture committed a guardrails.json');
    files.set(GR_PATH, '{"guardrails": [ {"id": 7} ]}\n');
    await commitSubtree('sales', 'knowledge/', files, { reposDir: dir, author: { name: 'x', email: 'x@example.com' }, message: 'break it' });
    const { result } = await captured(dir);
    assert.equal(result.ok, false);
    assert.match(result.detail, /guardrails\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NEGATIVE TWIN: the same workflow id committed in two domains refuses the source', async () => {
  const dir = await repos([workflowRecord()]);
  try {
    __setKnowledgeGitForTests(true);
    await commitKnowledge('finance', actor, { action: 'publish workflow' }, { reposDir: dir, mirror: false, captured: { workflows: [workflowRecord({ domain: 'finance' })], manual: null } });
    const { result } = await captured(dir);
    assert.equal(result.ok, false);
    assert.match(result.detail, /wf_bank/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OPA unreachable: the decision denies (policy_unreachable); there is no allow fallback', async () => {
  const d = await decideGuardrails('wf_bank', []);
  assert.deepEqual(d, { allow: false, reason: 'policy_unreachable', violated: [], guardrails: [] });
});

test('OPA unreachable: the push path reports a FAILURE, never an in-process mock', async () => {
  const r = await applyGuardrails(parseWorkflow(WF_MD));
  assert.equal(r.apply.status, 'fail');
  assert.equal(r.apply.applied, false);
  assert.equal(r.apply.verified, false);
  assert.notEqual(r.apply.policy as string, 'opa-mock');
});
