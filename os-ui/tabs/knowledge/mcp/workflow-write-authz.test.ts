/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every workflow write is decided by OPA before it happens (GLUE-7), and fails closed
 * USER STORY: As a platform owner I want authoring, indexing, publishing and retiring a workflow to
 *             be a governed OPA decision — allowed for the owner in My scope, refused for a creator
 *             publishing to Domain and for a user outside the domain — and I want a write refused
 *             when OPA does not answer, never waved through.
 * ARCHITECTURE:
 *   - Driven over `handleRpc` with the REAL `authorize()` (core/infra/governed.ts → the OPA
 *     adapter). Only the network is stubbed: `fetch` plays OPA with a scripted verdict, and records
 *     what the tool asked (`agentic/authz/workflow_write`, with the actor and the workflow's facts).
 *     The Rego itself is proven separately: `authz_test.rego` and `tests/opa/workflow-write.int.test.ts`
 *     (a real OPA container).
 *   - The test-environment gate the other suites run under (an allowing policy) is removed here, so
 *     these tests see the production path.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { handleRpc, type JsonRpcResponse } from '@core/mcp/server';
import { __resetStore as resetWorkflows, listWorkflows } from '@tabs/knowledge/lib/store';
import { __resetStore as resetNotes } from '@tabs/knowledge/lib/personal-store';
import { __resetApprovals } from '@core/policy/approvals';

const GATE = Symbol.for('soa.test.workflowWriteGate');
const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const dana: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };
const finaAdmin: CurrentUser = { id: 'fina', name: 'Fina', domains: ['finance'], role: 'domain_admin' };

type OpaAsk = { url: string; input: Record<string, unknown> };
let asks: OpaAsk[] = [];
let verdict: (input: Record<string, unknown>) => boolean | 'unreachable' | 500 = () => true;
const realFetch = globalThis.fetch;
let savedGate: unknown;

beforeEach(() => {
  savedGate = (globalThis as Record<symbol, unknown>)[GATE];
  delete (globalThis as Record<symbol, unknown>)[GATE]; // the production path: ask OPA
  asks = [];
  verdict = () => true;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (!u.includes('/v1/data/agentic/authz/')) return realFetch(url as string, init as RequestInit);
    const input = (JSON.parse(init?.body ?? '{}') as { input: Record<string, unknown> }).input;
    asks.push({ url: u, input });
    const v = verdict(input);
    if (v === 'unreachable') throw new Error('connect ECONNREFUSED');
    if (v === 500) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ result: v }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  resetWorkflows();
  resetNotes();
  __resetApprovals();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as Record<symbol, unknown>)[GATE] = savedGate;
});

async function raw(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res && 'result' in res, `expected a result for ${name}`);
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}
const payload = <T = Record<string, unknown>>(r: Record<string, unknown>): T => {
  assert.notEqual(r.isError, true, `expected success, got: ${(r.content as { text: string }[])[0]?.text}`);
  return JSON.parse((r.content as { text: string }[])[0].text) as T;
};
const errorOf = (r: Record<string, unknown>) => {
  assert.equal(r.isError, true, 'expected a typed tool error');
  return (r.structuredContent as { error: { code: string; reason: string } }).error;
};
const workflowsOf = (u: CurrentUser) => listWorkflows({ id: u.id, domains: u.domains, role: u.role }).mine;
const rule = (a: OpaAsk) => a.url.split('/authz/')[1];

// ─── allowed: the owner in My scope ───────────────────────────────────────────────────────

test('author_workflow asks OPA `workflow_write` (op create, the caller, a personal workflow of theirs) and, allowed, writes', async () => {
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Refund handling' }));
  assert.match(rec.id, /^wf_/);
  assert.equal(asks.length, 1, 'exactly one OPA decision for one write');
  assert.equal(rule(asks[0]), 'workflow_write');
  assert.equal(asks[0].input.op, 'create');
  assert.deepEqual(asks[0].input.actor, { id: 'cara', role: 'creator', domains: ['sales'] });
  assert.deepEqual(asks[0].input.workflow, { id: '', tier: 'personal', owner: 'cara', domain: 'sales' });
  assert.equal(asks[0].input.principal, 'user:cara');
  assert.equal(workflowsOf(cara).length, 1);
});

test('index_workflow and retire_workflow ask for their own op with the stored workflow facts, and run when allowed', async () => {
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'W' }));
  asks = [];
  payload(await raw(cara, 'index_workflow', { workflowId: rec.id }));
  assert.deepEqual(asks.map((a) => a.input.op), ['index']);
  assert.deepEqual(asks[0].input.workflow, { id: rec.id, tier: 'personal', owner: 'cara', domain: 'sales' });
  asks = [];
  payload(await raw(cara, 'retire_workflow', { workflowId: rec.id }));
  assert.deepEqual(asks.map((a) => a.input.op), ['retire']);
});

// ─── denied: nothing is written ───────────────────────────────────────────────────────────

test('NEGATIVE TWIN: OPA says no to author_workflow → typed forbidden and NO workflow exists afterwards', async () => {
  verdict = () => false;
  const e = errorOf(await raw(cara, 'author_workflow', { title: 'Nope' }));
  assert.equal(e.code, 'forbidden');
  assert.match(e.reason, /policy|OPA|not allowed|denied/i);
  assert.equal(workflowsOf(cara).length, 0, 'the refused write left nothing behind');
});

test('NEGATIVE TWIN: a domain admin OUTSIDE the domain is refused by OPA on publish; the workflow stays a draft', async () => {
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Sales flow' }));
  // The policy's verdict by the facts it was sent: only a domain admin OF the workflow's domain.
  verdict = (i) => i.op !== 'publish' || ((i.actor as { domains: string[] }).domains.includes((i.workflow as { domain: string }).domain));
  const res = await raw(finaAdmin, 'publish_workflow', { workflowId: rec.id });
  const e = errorOf(res);
  assert.ok(e.code === 'forbidden' || e.code === 'not_found', `refused (got ${e.code})`);
  assert.equal(workflowsOf(cara)[0].visibility, 'Personal', 'still My scope');
  // …and the in-domain admin, with the same verdict function, publishes.
  payload(await raw(cara, 'request_promotion', { kind: 'workflow', id: rec.id })); // the owner files, the domain admin approves
  asks = [];
  payload(await raw(dana, 'publish_workflow', { workflowId: rec.id }));
  assert.equal(asks.find((a) => a.input.op === 'publish') !== undefined, true, 'publish was put to OPA');
});

test('NEGATIVE TWIN: a creator cannot publish to Domain — the role floor refuses it and OPA is never the only door', async () => {
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Mine' }));
  asks = [];
  verdict = () => true; // even a policy that said yes would not matter: the floor is checked first
  const e = errorOf(await raw(cara, 'publish_workflow', { workflowId: rec.id }));
  assert.equal(e.code, 'forbidden');
  assert.equal(workflowsOf(cara)[0].visibility, 'Personal');
});

test('NEGATIVE TWIN: OPA says no to index_workflow / retire_workflow → neither runs', async () => {
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'W' }));
  verdict = () => false;
  assert.equal(errorOf(await raw(cara, 'index_workflow', { workflowId: rec.id })).code, 'forbidden');
  assert.equal(errorOf(await raw(cara, 'retire_workflow', { workflowId: rec.id })).code, 'forbidden');
  assert.equal(workflowsOf(cara).length, 1, 'not archived');
});

// ─── fail closed ──────────────────────────────────────────────────────────────────────────

test('NEGATIVE TWIN (fail closed): OPA unreachable → every workflow write is refused and writes nothing', async () => {
  verdict = () => 'unreachable';
  assert.equal(errorOf(await raw(cara, 'author_workflow', { title: 'x' })).code, 'forbidden');
  assert.equal(workflowsOf(cara).length, 0);
  verdict = () => true;
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'W' }));
  verdict = () => 'unreachable';
  for (const t of ['index_workflow', 'retire_workflow']) assert.equal(errorOf(await raw(cara, t, { workflowId: rec.id })).code, 'forbidden', `${t} fails closed`);
  assert.equal(errorOf(await raw(dana, 'publish_workflow', { workflowId: rec.id })).code, 'forbidden');
  assert.equal(workflowsOf(cara)[0].visibility, 'Personal');
});

test('NEGATIVE TWIN (fail closed): an OPA 500 refuses too, and OPA_FAIL_OPEN does not open a write', async () => {
  verdict = () => 500;
  assert.equal(errorOf(await raw(cara, 'author_workflow', { title: 'x' })).code, 'forbidden');
  assert.equal(workflowsOf(cara).length, 0);
});

// ─── the deprecated names go through the same door ────────────────────────────────────────

test('author_knowledge (deprecated alias) is decided by OPA exactly like author_workflow, and is refused when OPA is down', async () => {
  const ok = payload<{ id: string }>(await raw(cara, 'author_knowledge', { title: 'Old client' }));
  assert.match(ok.id, /^wf_/);
  assert.deepEqual(asks.map(rule), ['workflow_write']);
  verdict = () => 'unreachable';
  assert.equal(errorOf(await raw(cara, 'author_knowledge', { title: 'Old client 2' })).code, 'forbidden');
  assert.equal(workflowsOf(cara).length, 1);
});

test('the note tools are a different artifact: save_knowledge_note makes no workflow decision', async () => {
  verdict = () => false; // a policy that refuses every workflow write
  const note = payload<{ id: string }>(await raw(cara, 'save_knowledge_note', { title: 'N', md: 'text' }));
  assert.match(note.id, /^pk_/);
  assert.equal(asks.filter((a) => rule(a) === 'workflow_write').length, 0);
});

// ─── the prompt that starts a workflow write ──────────────────────────────────────────────

async function getPrompt(user: CurrentUser): Promise<JsonRpcResponse> {
  return (await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'author_and_publish_workflow', arguments: { topic: 'refunds' } } })) as JsonRpcResponse;
}

test('prompts/get author_and_publish_workflow: allowed → the script; refused or OPA unreachable → a forbidden error, no script', async () => {
  const ok = await getPrompt(cara);
  assert.ok('result' in ok && ok.result, 'the prompt renders when the policy allows a workflow create');
  assert.equal(rule(asks[0]), 'workflow_write');
  assert.equal(asks[0].input.op, 'create');
  verdict = () => false;
  const denied = await getPrompt(cara);
  assert.ok(denied.error && /forbidden/i.test(denied.error.message));
  verdict = () => 'unreachable';
  const down = await getPrompt(cara);
  assert.ok(down.error && /forbidden/i.test(down.error.message), 'fail closed');
});

// ═══ Verifier findings: the other doors (effect, REST, OKF import), the test seam, the migration ═══

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promoteThroughSeam } from '@core/policy/ladder';
import { workflowWriteTestGate } from '@core/infra/governed';
import { getWorkflow } from '@tabs/knowledge/lib/store';
import { exportAndValidate, exportWorkflowBundle } from '@tabs/knowledge/lib/okf-export';
import { zipBundle } from '@tabs/knowledge/lib/okf-zip';

const cora: CurrentUser = { id: 'cora', name: 'Cora', domains: ['sales'], role: 'creator' };
const principal = (u: CurrentUser) => ({ id: u.id, domains: u.domains, role: u.role });

test('SEAM: the test gate is honoured under node --test, and NEVER when NODE_ENV is production', () => {
  (globalThis as Record<symbol, unknown>)[GATE] = () => true;
  assert.equal(typeof workflowWriteTestGate(), 'function', 'under the test runner an installed gate is honoured');
  const env = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
  try {
    assert.equal(workflowWriteTestGate(), undefined, 'production ignores it even if something set the symbol');
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = env;
    delete (globalThis as Record<symbol, unknown>)[GATE];
  }
});

// ─── the approval effect (publish through the ladder seam) ────────────────────────────────

async function filed(): Promise<string> {
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'To approve' }));
  payload(await raw(cara, 'request_promotion', { kind: 'workflow', id: rec.id }));
  asks = [];
  return rec.id;
}

test('EFFECT: the approval publishes only if OPA allows `publish` for the APPROVER — and asks as the approver', async () => {
  const id = await filed();
  await promoteThroughSeam('knowledge', id, dana, { rung: 'promote' });
  const ask = asks.find((a) => a.input.op === 'publish');
  assert.ok(ask, 'the effect asked OPA before publishing');
  assert.deepEqual(ask!.input.actor, { id: 'dana', role: 'domain_admin', domains: ['sales'] }, 'the approver, not the requester');
  assert.equal(ask!.input.principal, 'user:dana');
  assert.equal(getWorkflow(id, principal(dana)).visibility, 'Shared');
});

test('NEGATIVE TWIN: OPA refuses the approver’s publish → the effect fails and the workflow stays Personal; unreachable OPA fails closed', async () => {
  const id = await filed();
  verdict = () => false;
  await assert.rejects(() => promoteThroughSeam('knowledge', id, dana, { rung: 'promote' }), (e: { status?: number }) => e.status === 403);
  assert.equal(getWorkflow(id, principal(cara)).visibility, 'Personal');
  verdict = () => 'unreachable';
  await assert.rejects(() => promoteThroughSeam('knowledge', id, dana, { rung: 'promote' }), (e: { status?: number }) => e.status === 403);
  assert.equal(getWorkflow(id, principal(cara)).visibility, 'Personal');
});

test('EFFECT: certify is a separate OPA op (`certify`)', async () => {
  const id = await filed();
  await promoteThroughSeam('knowledge', id, dana, { rung: 'promote' });
  asks = [];
  const ada: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };
  payload(await raw(dana, 'request_certification', { kind: 'workflow', id }));
  verdict = (i) => i.op !== 'certify';
  await assert.rejects(() => promoteThroughSeam('knowledge', id, ada, { rung: 'certify' }), (e: { status?: number }) => e.status === 403);
  assert.ok(asks.some((a) => a.input.op === 'certify'));
  assert.equal(getWorkflow(id, principal(ada)).visibility, 'Shared');
});

// ─── the REST routes: every mutating handler asks OPA first, with the right op ───────────

const ROUTES: Record<string, Record<string, string>> = {
  'app/api/knowledge/workflows/route.ts': { POST: 'create' },
  'app/api/knowledge/workflows/[id]/route.ts': { PATCH: 'update', POST: "'retire'|'update'", DELETE: 'retire' },
  'app/api/knowledge/workflows/[id]/folder/route.ts': { POST: 'update' },
  'app/api/knowledge/workflows/[id]/tacit/route.ts': { PUT: 'update' },
  'app/api/knowledge/workflows/[id]/versions/route.ts': { POST: 'update' },
  'app/api/knowledge/workflows/[id]/index/route.ts': { POST: 'index' },
  // Applying a workflow's guardrails pushes its policy to OPA (an edit-level action); a retrieve that finds the
  // workflow unindexed indexes it first (an index write).
  'app/api/knowledge/workflows/[id]/guardrails/route.ts': { POST: 'update' },
  'app/api/knowledge/workflows/[id]/retrieve/route.ts': { POST: 'index' },
};

function handlerBody(src: string, verb: string): string {
  const start = src.indexOf(`export const ${verb} =`);
  assert.ok(start >= 0, `handler ${verb} exists`);
  const next = src.indexOf('\nexport const ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

for (const [file, verbs] of Object.entries(ROUTES)) {
  test(`REST: ${file.replace('app/api/knowledge/workflows', '…')} — ${Object.keys(verbs).join('/')} ask workflow_write BEFORE the store write`, () => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(src, /import \{[^}]*\bauthorize\b[^}]*\} from '@core\/infra\/governed'/, 'the route imports the OPA authorize');
    for (const verb of Object.keys(verbs)) {
      const body = handlerBody(src, verb);
      const gateAt = body.search(/await gate\(|authorize\(/);
      const writeAt = body.search(/\b(createWorkflow|updateWorkflow|deleteWorkflow|archiveWorkflow|unarchiveWorkflow|renameKnowledge|setWorkflowLinks|moveWorkflow|updateTacit|restoreWorkflowVersion|indexWorkflow|applyGuardrails|verifyGuardrails)\(/);
      assert.ok(gateAt >= 0, `${verb}: asks the policy`);
      assert.ok(writeAt === -1 || gateAt < writeAt, `${verb}: the policy is asked before the store is touched`);
      assert.match(body, /workflow_write|gate\(/, `${verb}: it is the workflow_write door`);
    }
  });
}

test('REST: the gates name the real op — create / update / retire / index', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
  assert.match(handlerBody(read('app/api/knowledge/workflows/route.ts'), 'POST'), /'create'/);
  const idRoute = read('app/api/knowledge/workflows/[id]/route.ts');
  assert.match(handlerBody(idRoute, 'DELETE'), /'retire'/);
  assert.match(handlerBody(idRoute, 'PATCH'), /'update'/);
  assert.match(handlerBody(idRoute, 'POST'), /'retire'/);
  assert.match(handlerBody(read('app/api/knowledge/workflows/[id]/index/route.ts'), 'POST'), /'index'/);
  assert.match(handlerBody(read('app/api/knowledge/workflows/[id]/guardrails/route.ts'), 'POST'), /'update'/);
  assert.match(handlerBody(read('app/api/knowledge/workflows/[id]/retrieve/route.ts'), 'POST'), /'index'/);
});

test('REST: the routes that stay un-gated are READS of workflow state — none calls a workflow store mutator or the indexer', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
  const MUTATORS = /\b(createWorkflow|updateWorkflow|deleteWorkflow|archiveWorkflow|unarchiveWorkflow|renameKnowledge|setWorkflowLinks|moveWorkflow|updateTacit|restoreWorkflowVersion|publishWorkflow|certifyWorkflow|indexWorkflow|importOkfZip|importBundle)\(/;
  const reads: [string, string[]][] = [
    ['app/api/knowledge/workflows/[id]/eval/route.ts', ['POST']], // scores retrieval over in-memory units; stores nothing
    ['app/api/knowledge/workflows/[id]/scaffold-agent/route.ts', ['POST']], // reads the workflow; `create` makes an AGENT system (agents door), not a workflow write
    ['app/api/knowledge/workflows/[id]/okf/route.ts', ['GET']], // export
    ['app/api/knowledge/workflows/[id]/guardrails/route.ts', ['GET']], // compile (preview)
    ['app/api/knowledge/workflows/[id]/tacit/route.ts', ['GET']],
    ['app/api/knowledge/workflows/[id]/versions/route.ts', ['GET']],
  ];
  for (const [file, verbs] of reads) {
    const src = read(file);
    for (const verb of verbs) {
      const body = src.includes(`export const ${verb} =`) ? handlerBody(src, verb) : src.slice(src.indexOf(`export async function ${verb}`));
      assert.doesNotMatch(body, MUTATORS, `${file} ${verb} is a read and must stay one`);
    }
  }
  // There is no REST door for an OKF import: the only importer is the MCP tool (gated per concept).
  const importers = ['app/api/knowledge/workflows/route.ts', 'app/api/knowledge/workflows/[id]/okf/route.ts'].map(read).join('\n');
  assert.doesNotMatch(importers, /importOkfZip|importBundle/);
});

test('the retrieve route asks for `index` before its lazy index, and a refusal skips the write instead of failing the read', () => {
  const body = handlerBody(readFileSync(join(process.cwd(), 'app/api/knowledge/workflows/[id]/retrieve/route.ts'), 'utf8'), 'POST');
  const askAt = body.indexOf("'index'");
  const idxAt = body.indexOf('await indexWorkflow(');
  assert.ok(askAt >= 0 && askAt < idxAt, 'asked before indexing');
  assert.match(body, /canIndex/, 'the answer decides whether the lazy index runs');
});

// ─── OKF import: each workflow concept is authorised with its REAL op ────────────────────

function zipOf(id: string, user: CurrentUser): string {
  const view = getWorkflow(id, principal(user));
  const { bundle } = exportAndValidate(exportWorkflowBundle(view));
  return zipBundle(bundle).toString('base64');
}

test('OKF import: a matched workflow is an UPDATE decided by OPA; a new one is a CREATE; refused items are skipped, nothing written', async () => {
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Original', steps: [{ title: 'Step one', actor: 'Human' }] }));
  const b64 = zipOf(rec.id, cara);
  const before = getWorkflow(rec.id, principal(cara)).updatedAt;
  asks = [];
  verdict = (i) => i.op !== 'update'; // creates allowed, updates refused
  const r = payload<{ imported: { id: string; outcome: string }[]; skipped: { reason: string }[] }>(await raw(cara, 'import_okf_bundle', { base64Content: b64 }));
  assert.deepEqual(asks.map((a) => a.input.op), ['update'], 'the matched concept is an update — not a create');
  assert.equal(r.imported.filter((x) => x.outcome === 'versioned').length, 0, 'the refused update imported nothing');
  assert.ok(r.skipped.some((s) => /policy|refused|not allowed/i.test(s.reason)), 'and says why');
  assert.equal(getWorkflow(rec.id, principal(cara)).updatedAt, before, 'the workflow was not touched');
  // Allowed update → versioned. Another creator (cannot see cara's draft) → a CREATE.
  asks = [];
  verdict = () => true;
  const ok = payload<{ imported: { outcome: string }[] }>(await raw(cara, 'import_okf_bundle', { base64Content: b64 }));
  assert.deepEqual(ok.imported.map((x) => x.outcome), ['versioned']);
  assert.deepEqual(asks.map((a) => a.input.op), ['update']);
  asks = [];
  const created = payload<{ imported: { outcome: string }[] }>(await raw(cora, 'import_okf_bundle', { base64Content: b64 }));
  assert.deepEqual(created.imported.map((x) => x.outcome), ['created']);
  assert.deepEqual(asks.map((a) => a.input.op), ['create']);
});

test('NEGATIVE TWIN (fail closed): OPA unreachable → the import writes no workflow at all', async () => {
  const rec = payload<{ id: string }>(await raw(cara, 'author_workflow', { title: 'Original' }));
  const b64 = zipOf(rec.id, cara);
  verdict = () => 'unreachable';
  const r = payload<{ imported: unknown[]; skipped: unknown[] }>(await raw(cora, 'import_okf_bundle', { base64Content: b64 }));
  assert.equal(r.imported.length, 0);
  assert.equal(workflowsOf(cora).length, 0);
});
