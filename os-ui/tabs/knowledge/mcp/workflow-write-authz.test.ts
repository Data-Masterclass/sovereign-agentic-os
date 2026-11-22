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
