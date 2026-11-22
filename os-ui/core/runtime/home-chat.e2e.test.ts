/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    A Home chat turn, proven against the REAL LiteLLM, Langfuse and OPA containers
 * USER STORY: As the owner I need proof, not a mock, that one chat turn is ONE Langfuse trace and
 *             that the governed tool it called was decided by OPA.
 * ARCHITECTURE:
 *   - Runs only under scripts/tests/home-chat/run.sh (LiteLLM image + chart config, Langfuse, and
 *     OPA 1.x with the chart's authz.rego and decision logging to the console). Unset env = SKIP;
 *     HOME_CHAT_E2E_REQUIRED=1 turns a skip into a failure.
 *   - The turn is `runOsAssistant` with `confirm` (the Home chat path). Every model call goes
 *     through os-ui's real gateway caller to the real gateway; only the model PROVIDER is a stub, so
 *     the one tool call (`search_knowledge`, which asks OPA's `retrieve` gate) is put in the model's
 *     reply by this test. The tool then runs through the real `handleRpc` -> OPA.
 *   - NEGATIVE TWINS: (1) the same turn with a non-W3C turn id (what the drawer used) lands in MORE
 *     than one Langfuse trace; (2) a user whose domain has no grant is DENIED by OPA, and the log
 *     says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const LF = (process.env.LANGFUSE_E2E_URL ?? '').replace(/\/+$/, '');
const PK = process.env.LANGFUSE_E2E_PUBLIC_KEY ?? '';
const SK = process.env.LANGFUSE_E2E_SECRET_KEY ?? '';
const OPA_CONTAINER = process.env.HOME_CHAT_E2E_OPA_CONTAINER ?? '';
const STUB_LOG = process.env.HOME_CHAT_E2E_STUB_LOG ?? '';
const REQUIRED = process.env.HOME_CHAT_E2E_REQUIRED === '1';
const skip = !LF && !REQUIRED ? 'LANGFUSE_E2E_URL is not set (run scripts/tests/home-chat/run.sh)' : false;
const basic = `Basic ${Buffer.from(`${PK}:${SK}`).toString('base64')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => randomBytes(n).toString('hex');

type Trace = { id: string; userId?: string | null; observations?: { type: string }[] };

async function tracesOf(userId: string, atLeast: number): Promise<Trace[]> {
  let list: Trace[] = [];
  for (let i = 0; i < 45; i++) {
    const r = await fetch(`${LF}/api/public/traces?userId=${encodeURIComponent(userId)}&limit=50`, { headers: { authorization: basic } });
    if (r.ok) list = ((await r.json()) as { data?: Trace[] }).data ?? [];
    if (list.length >= atLeast) break;
    await sleep(2000);
  }
  await sleep(8000); // a late second trace would arrive in this window
  const r = await fetch(`${LF}/api/public/traces?userId=${encodeURIComponent(userId)}&limit=50`, { headers: { authorization: basic } });
  if (r.ok) list = ((await r.json()) as { data?: Trace[] }).data ?? list;
  return list;
}

/** The distinct models (and node names) of the GENERATIONs inside one trace, as Langfuse recorded them. */
async function generationsOf(traceId: string, atLeast: number): Promise<{ model: string; name: string }[]> {
  let out: { model: string; name: string }[] = [];
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${LF}/api/public/traces/${traceId}`, { headers: { authorization: basic } });
    if (r.ok) {
      const obs = ((await r.json()) as { observations?: { type: string; model?: string | null; name?: string | null }[] }).observations ?? [];
      out = obs.filter((o) => o.type === 'GENERATION').map((o) => ({ model: o.model ?? '', name: o.name ?? '' }));
      if (out.length >= atLeast) break;
    }
    await sleep(2000);
  }
  return out;
}

/** The upstream models the stub provider was called with (what the gateway really routed to), in order. */
const upstreamModels = (): string[] => (STUB_LOG && existsSync(STUB_LOG) ? readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { model: string }).model) : []);

async function generationCount(traceId: string): Promise<number> {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${LF}/api/public/traces/${traceId}`, { headers: { authorization: basic } });
    if (r.ok) {
      const n = (((await r.json()) as Trace).observations ?? []).filter((o) => o.type === 'GENERATION').length;
      if (n >= 3) return n;
    }
    await sleep(2000);
  }
  return 0;
}

/** The decision-log lines OPA wrote to the console for this tool and principal. */
function opaDecisions(tool: string, principal: string): { effect: unknown; decision_id?: string }[] {
  // OPA writes its decision log to stderr; `docker logs` replays it on stderr, so merge the streams.
  const logs = execFileSync('sh', ['-c', 'docker logs "$1" 2>&1', 'sh', OPA_CONTAINER], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out: { effect: unknown; decision_id?: string }[] = [];
  for (const line of logs.split('\n')) {
    if (!line.startsWith('{') || !line.includes('"decision_id"')) continue;
    try {
      const d = JSON.parse(line) as { path?: string; input?: { tool?: string; principal?: string }; result?: { effect?: unknown }; decision_id?: string };
      if (d.path === 'agentic/authz/decision' && d.input?.tool === tool && d.input?.principal === principal) out.push({ effect: d.result?.effect, decision_id: d.decision_id });
    } catch { /* not a decision line */ }
  }
  return out;
}

async function turn(user: { id: string; domains: string[] }, traceId?: string, delegate = false, escalate = false) {
  const { runOsAssistant } = await import('@core/runtime/agent-loop');
  const { liteLlmCaller } = await import('@core/runtime/runtime');
  const real = liteLlmCaller({ userId: user.id, domain: user.domains[0], tab: 'ask' });
  let acted = false;
  let delegated = false;
  let escalated = false;
  const llm: import('@core/runtime/agentic').LlmCall = async (req) => {
    const c = await real(req);
    if (req.tools && !acted) { // the stub provider cannot call tools: this test puts the call in its reply
      acted = true;
      return { ...c, content: '', toolCalls: [{ id: 'k1', name: 'search_knowledge', args: { query: 'onboarding' } }] };
    }
    // COST-SAVING MODE: the worker leads and, for a task it judges too hard, calls escalate_to_strong.
    if (escalate && req.tools && req.model === 'sovereign-worker' && !escalated) {
      escalated = true;
      return { ...c, content: '', toolCalls: [{ id: 'k3', name: 'escalate_to_strong', args: { reason: 'too hard for the worker' } }] };
    }
    // STRONG decides to delegate: the stub cannot, so this test puts the decision in strong's reply.
    if (delegate && req.tools && !delegated) {
      delegated = true;
      return { ...c, content: '', toolCalls: [{ id: 'k2', name: 'delegate_to_worker', args: { preset: 'summarise_tool_result', input_refs: ['last'] } }] };
    }
    return c;
  };
  return runOsAssistant({
    user: { id: user.id, name: user.id, domains: user.domains, role: 'creator' },
    tab: null,
    messages: [{ role: 'user', content: 'How do we onboard a customer?' }],
    confirm: { conversationId: `conv-${hex(6)}` },
    llm,
    ...(traceId ? { traceId } : {}),
  });
}

test('home chat e2e: the environment names Langfuse and OPA', { skip }, () => {
  for (const [k, v] of Object.entries({ LANGFUSE_E2E_URL: LF, LANGFUSE_E2E_PUBLIC_KEY: PK, LANGFUSE_E2E_SECRET_KEY: SK, HOME_CHAT_E2E_OPA_CONTAINER: OPA_CONTAINER })) {
    assert.ok(v, `${k} must be set when HOME_CHAT_E2E_REQUIRED=1`);
  }
});

test('home chat e2e: one turn is ONE Langfuse trace (with every model call in it) and OPA decided the tool', { skip, timeout: 300_000 }, async () => {
  const user = { id: `u-e2e-${hex(4)}`, domains: ['sales'] };
  const res = await turn(user);
  assert.equal(res.pending.length, 0, 'search_knowledge is a read: it runs without a confirmation');
  const step = res.steps.find((s) => s.tool === 'search_knowledge');
  assert.ok(step, 'the tool ran');
  assert.match(res.traceId, /^[0-9a-f]{32}$/);

  const traces = await tracesOf(user.id, 1);
  assert.equal(traces.length, 1, `exactly one Langfuse trace for the turn, got ${traces.length}: ${traces.map((t) => t.id).join(', ')}`);
  assert.equal(traces[0].id, res.traceId, 'and it is the turn id the API returned');
  assert.ok((await generationCount(res.traceId)) >= 3, 'plan, act and the final answer are three generations inside it');

  const d = opaDecisions('retrieve', 'sales');
  assert.ok(d.length >= 1, 'OPA logged a decision for the retrieve gate');
  assert.equal(d.at(-1)?.effect, 'allow', 'granted domain: allow');
  assert.ok(d.at(-1)?.decision_id, 'with a decision id');
});

test('NEGATIVE TWIN (trace): a turn id that is not a W3C id (the drawer\'s old form) is NOT one trace', { skip, timeout: 300_000 }, async () => {
  const user = { id: `u-e2e-${hex(4)}`, domains: ['sales'] };
  await turn(user, `ask-${hex(8)}`);
  const traces = await tracesOf(user.id, 3);
  assert.ok(traces.length > 1, `without a W3C id each model call is its own trace; got ${traces.length}`);
});

test('NEGATIVE TWIN (policy): a domain OPA has no grant for is denied, and the decision log says deny', { skip, timeout: 300_000 }, async () => {
  const user = { id: `u-e2e-${hex(4)}`, domains: ['nogrant'] };
  const res = await turn(user);
  const step = res.steps.find((s) => s.tool === 'search_knowledge');
  assert.ok(step && /deny/i.test(step.result), `the governed tool reports the denial: ${step?.result.slice(0, 200)}`);
  const d = opaDecisions('retrieve', 'nogrant');
  assert.ok(d.length >= 1 && d.every((x) => x.effect === 'deny'), 'OPA decided deny');
});

test('ROLES e2e: strong leads on one catalog model, a delegation runs on a DIFFERENT one, and the trace and Langfuse show both', { skip, timeout: 300_000 }, async () => {
  const user = { id: `u-e2e-${hex(4)}`, domains: ['sales'] };
  const before = upstreamModels().length;
  const res = await turn(user, undefined, true);
  const upstream = new Set(upstreamModels().slice(before));
  assert.ok(upstream.size === 2, `the gateway called TWO distinct catalog models upstream (strong's and the worker's), got ${[...upstream].join(' | ') || 'none'}`);
  const roles = res.modelTrace.calls.map((c) => `${c.purpose}:${c.role}`);
  assert.ok(roles.includes('plan:strong') && roles.includes('delegate:summarise_tool_result:worker'), roles.join(', '));
  assert.equal(res.modelTrace.delegations[0]?.role, 'worker', 'the stub answers the schema, so no escalation');
  assert.equal(res.modelTrace.delegations[0]?.escalated, false);
  const gens = await generationsOf(res.traceId, 5);
  assert.ok(gens.length >= 5, `plan, two acts, the worker and the answer are five generations in ONE trace, got ${gens.length}`);
  assert.ok(gens.some((g) => /sovereign-worker/.test(g.name)) && gens.some((g) => /sovereign-strong/.test(g.name)), `both roles are generations of the one trace: ${gens.map((g) => g.name).join(', ')}`);
});

test('NEGATIVE TWIN (roles): a turn in which strong does not delegate runs on ONE catalog model only', { skip, timeout: 300_000 }, async () => {
  const user = { id: `u-e2e-${hex(4)}`, domains: ['sales'] };
  const before = upstreamModels().length;
  const res = await turn(user);
  assert.ok(res.modelTrace.calls.every((c) => c.role === 'strong'));
  assert.equal(new Set(upstreamModels().slice(before)).size, 1, 'one upstream model, so the two-model check above is not trivially true');
});

test('LEAD SWITCH e2e (ON): the worker leads on one catalog model, escalates, and strong answers on ANOTHER; the trace shows the escalation', { skip, timeout: 300_000 }, async () => {
  const { __setStandardFirstForTests } = await import('@core/models/roles');
  __setStandardFirstForTests(true);
  try {
    const user = { id: `u-e2e-${hex(4)}`, domains: ['sales'] };
    const before = upstreamModels().length;
    const res = await turn(user, undefined, false, true);
    assert.equal(res.modelTrace.calls[0].role, 'worker', 'the worker plans');
    assert.ok(res.modelTrace.calls.some((c) => c.role === 'strong'), 'strong ran after the escalation');
    assert.equal(res.modelTrace.escalations.length, 1);
    assert.equal(res.modelTrace.escalations[0].tool, 'escalate_to_strong');
    assert.equal(new Set(upstreamModels().slice(before)).size, 2, 'two distinct upstream catalog models in one turn');
  } finally {
    __setStandardFirstForTests(false);
  }
});

test('LEAD SWITCH e2e twin (OFF, the default): strong leads from the first call and nothing escalates', { skip, timeout: 300_000 }, async () => {
  const user = { id: `u-e2e-${hex(4)}`, domains: ['sales'] };
  const res = await turn(user);
  assert.equal(res.modelTrace.calls[0].role, 'strong');
  assert.equal(res.modelTrace.escalations.length, 0);
});
