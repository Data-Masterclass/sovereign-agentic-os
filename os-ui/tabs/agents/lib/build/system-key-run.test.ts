/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A run really uses the system's own key — end to end, Build to model call
 * USER STORY: As a platform admin I want proof that the key Build registered is the key every
 *             model call of that system's run carries — in another process, after a restart and
 *             across a rotation — that a system with no key stops with "press Build" instead of
 *             spending on the shared key, and that the key never shows up in anything a run
 *             returns or emits.
 * ARCHITECTURE:
 *   - The REAL pieces: the Build's `litellm` adapter, the Postgres key store (over a fake SQL
 *     client that only keeps rows), `runOsTeam` with its production model caller
 *     (`liteLlmCaller`, no injected LLM) and `callerCredential`.
 *   - The FAKES: the gateway. Its admin side is a `LiteLlmClient` holding keys by token id; its
 *     inference side is a `fetch` stub that authenticates the bearer against those same keys —
 *     so a deleted or rotated key is answered 401 exactly as LiteLLM would.
 *   - "Another process" is a fresh store object over the same rows plus an empty read cache —
 *     what the `os-ui-worker` has: the database and the encryption secret, nothing in memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CurrentUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import {
  SystemKeyUnavailableError,
  __setSystemKeyStoreForTests,
  deploymentKek,
  mintSystemKey,
  memorySystemKeyJournal,
  postgresSystemKeyStore,
  resolveSystemKey,
  sealSystemKey,
  systemKeyRef,
  systemKeyStatus,
  tokenIdOf,
  type SqlClient,
} from '@core/infra/agent-system-keys';
import { SystemKeyRefusedError } from '@core/infra/litellm-credential';
import { __setRotationWaitForTests, liteLlmCaller } from '@core/runtime/runtime';
import { parseSystem, serializeSystem } from '@tabs/agents/lib/system-schema';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import { makeLiveAdapters, type LiteLlmClient, type LiteLlmKeyInput, type LiteLlmKeyState, type LiveDeps } from '@tabs/agents/lib/build/live';
import { rotateSystemKeyWith } from '@tabs/agents/lib/build/system-key-admin';
import { runOsTeam } from '@tabs/agents/lib/build/agentic-graph-server';
import type { OsToolDeps } from '@tabs/agents/lib/build/os-tools';

const SHARED_KEY = config.litellmAgentKey;
const CREATOR: CurrentUser = { id: 'u1', name: 'Cara Creator', domains: ['sales'], role: 'creator' };
const YAML = serializeSystem(parseSystem({
  version: '1',
  system: { name: 'Insights', domain: 'sales', visibility: 'Personal' },
  runtime: 'langgraph',
  entrypoint: 'analyst',
  grants: { tools: ['query_data'] },
  agents: [{ id: 'analyst', role: 'agent', agent_md: 'You analyse.', memory_md: '' }],
}));

/** The rows of `agent_system_keys`, shared by every "process" in a test. */
function fakeDb(): SqlClient {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    async query(text, values = []) {
      if (/^\s*INSERT INTO agent_system_keys/.test(text)) {
        const [system_id, key_alias, token_id, kek_id, nonce, ciphertext, tag, caps, created, rotated] = values as [string, string, string, string, string, string, string, string, number, number | null];
        rows.set(system_id, { system_id, key_alias, token_id, kek_id, nonce, ciphertext, tag, caps: JSON.parse(caps), created_at: new Date(created), rotated_at: rotated === null ? null : new Date(rotated) });
        return { rows: [], rowCount: 1 };
      }
      if (/WHERE system_id = \$1/.test(text) && /^\s*SELECT/.test(text)) {
        const r = rows.get(String(values[0]));
        return { rows: r ? [r] : [], rowCount: r ? 1 : 0 };
      }
      if (/^\s*DELETE/.test(text)) { rows.delete(String(values[0])); return { rows: [], rowCount: 1 }; }
      return { rows: [...rows.values()], rowCount: rows.size };
    },
  };
}

/** The gateway: keys by alias (admin side) and a bearer check against them (inference side). */
function fakeGateway() {
  const keys = new Map<string, LiteLlmKeyState>();
  const state = (input: LiteLlmKeyInput, tokenId: string): LiteLlmKeyState => ({
    tokenId, models: [...input.models], maxBudget: input.maxBudget, budgetDuration: input.budgetDuration,
    rpmLimit: input.rpmLimit, tpmLimit: input.tpmLimit, maxParallelRequests: input.maxParallelRequests, allowedTools: [...input.allowedTools],
  });
  const admin: LiteLlmClient = {
    async keysByAlias(alias) { const k = keys.get(alias); return k ? [k] : []; },
    async generateKey(input, key) { keys.set(input.alias, state(input, tokenIdOf(key))); },
    async updateKey(tokenId, input) { keys.set(input.alias, state(input, tokenId)); },
    async deleteKey(tokenId) { for (const [a, k] of keys) if (k.tokenId === tokenId) keys.delete(a); },
    async expireKey() { /* not reached with a grace of 0 */ },
    async renameKey(tokenId, alias) { for (const [a, k] of [...keys]) if (k.tokenId === tokenId) { keys.delete(a); keys.set(alias, k); } },
    async models() { return []; },
  };
  /** Every bearer an inference call presented, in order, with the answer it got. */
  const calls: { bearer: string; status: number; body: string }[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('/v1/chat/completions')) throw new Error('offline-stub');
    const bearer = String((init?.headers as Record<string, string>)?.authorization ?? '').replace(/^Bearer /, '');
    const key = [...keys.values()].find((k) => k.tokenId === tokenIdOf(bearer));
    const model = String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? '');
    let status = 200;
    let payload: unknown = { choices: [{ message: { role: 'assistant', content: 'done: nothing to report' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
    if (!key) { status = 401; payload = { error: { message: 'Authentication Error, Invalid proxy server token passed', code: '401' } }; }
    else if (!key.models.includes(model)) { status = 403; payload = { error: { message: `key not allowed to access model. This key can only access models=${JSON.stringify(key.models)}`, type: 'key_model_access_denied' } }; }
    calls.push({ bearer, status, body: String(init?.body ?? '') });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { keys, admin, calls, fetchStub };
}

const noTools: OsToolDeps = {
  enqueue: (() => ({}) as never) as OsToolDeps['enqueue'],
  handleRpc: (async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } })) as OsToolDeps['handleRpc'],
  trace: (async () => ({}) as never) as OsToolDeps['trace'],
};

/** One deployment: a database, a gateway, and the Build wired to both — as os-ui web has it. */
function deployment() {
  const db = fakeDb();
  const gw = fakeGateway();
  const build: LiveDeps = {
    opa: { putGrants: async () => undefined, mergeRequiresApproval: async () => undefined, decision: async (_p, tool) => ({ effect: tool === 'connection_ghost' ? 'deny' : 'allow', reason: '' }) },
    litellm: gw.admin,
    langfuse: { ensureProject: async () => undefined, tracesFor: async () => 0 },
    // Grace 0: the old value must be refused right after the rotation here (the grace is tested in system-key-migration.test.ts).
    keys: { store: postgresSystemKeyStore(db), journal: memorySystemKeyJournal(), kek: () => deploymentKek(), retireGraceSeconds: 0 },
    // The models this run will actually ask for: the role models the engine resolves.
    runModels: () => [config.litellmReasoningModel, config.litellmToolsModel, 'sovereign-mock'],
  };
  /** Become "another process": a new store object over the same rows, nothing cached. */
  const asWorker = () => __setSystemKeyStoreForTests(postgresSystemKeyStore(db));
  return { db, gw, build, asWorker };
}

async function withGateway<T>(gw: ReturnType<typeof fakeGateway>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = gw.fetchStub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

async function runOnce(systemId: string, events: unknown[]) {
  return runOsTeam({
    runId: `run-${systemId}-${events.length}`,
    user: CREATOR,
    yaml: YAML,
    systemId,
    messages: [{ role: 'user', content: 'Anything to report?' }],
    toolDeps: noTools,
    maxIterations: 2,
    keyRef: systemKeyRef(systemId),
    onNodeStart: (ev) => events.push(['node-started', ev]),
    onStep: (ev) => events.push(['tool-step', ev]),
    onNodeComplete: (ev) => events.push(['node-completed', ev]),
  });
}

test('A RUN IN ANOTHER PROCESS uses the key Build registered — on every model call, never the shared key', async () => {
  const d = deployment();
  const report = await orchestrateBuild({ yaml: YAML, systemId: 'sys_run', adapters: makeLiveAdapters(d.build), probe: 'p' });
  assert.equal(report.rows.find((r) => r.tool === 'litellm')!.status, 'ok', JSON.stringify(report.rows));
  d.asWorker();
  const own = (await resolveSystemKey('sys_run')).key;
  d.asWorker(); // and a restart on top: nothing in memory when the run starts

  const events: unknown[] = [];
  const res = await withGateway(d.gw, () => runOnce('sys_run', events));
  assert.ok(d.gw.calls.length >= 2, 'the plan step and the act step both called the model');
  for (const c of d.gw.calls) {
    assert.equal(c.status, 200, `the gateway refused a call: ${c.status}`);
    assert.equal(c.bearer, own, 'a model call did not carry the system\'s own key');
    assert.notEqual(c.bearer, SHARED_KEY);
    assert.notEqual(c.bearer, config.litellmMasterKey);
  }
  assert.match(res.finalText, /nothing to report/);

  // NOTHING the run returns, emits or sends in a request BODY contains the key (the gateway logs bodies).
  const serialised = JSON.stringify({ res, events, status: await systemKeyStatus('sys_run'), report, bodies: d.gw.calls.map((c) => c.body) });
  assert.ok(!serialised.includes(own), 'the key leaked into the run record, an event or a request body');
  assert.doesNotMatch(serialised, /sk-[A-Za-z0-9_-]{20,}/, 'something shaped like a key is in the serialised output');
  __setSystemKeyStoreForTests(null);
});

test('NO KEY, NO RUN: a system that was never built makes NO model call — not on the shared key either — and says "press Build"', async () => {
  const d = deployment();
  d.asWorker();
  const events: unknown[] = [];
  let outcome = '';
  await withGateway(d.gw, async () => {
    try { outcome = JSON.stringify(await runOnce('sys_never_built', events)); } catch (e) { outcome = `${(e as Error).name}: ${(e as Error).message}`; }
  });
  assert.equal(d.gw.calls.length, 0, 'a model call was made for a system with no key of its own');
  assert.match(outcome, /no model key of its own/);
  assert.match(outcome, /press Build/);
  await assert.rejects(resolveSystemKey('sys_never_built'), SystemKeyUnavailableError);
  __setSystemKeyStoreForTests(null);
});

test('RUN SERVICE: the run asks for the system\'s key BEFORE the engine starts, and passes the reference — never a fallback', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-service.ts', import.meta.url)), 'utf8');
  const fn = src.slice(src.indexOf('export async function executeTeamRun'));
  const preflight = fn.indexOf('await resolveSystemKey(id, { fresh: true })');
  assert.ok(preflight > 0, 'executeTeamRun must check the system has a usable key');
  assert.ok(preflight < fn.indexOf('runOsTeam)({'), 'the check runs before the engine does');
  assert.ok(preflight > fn.indexOf('try {'), 'inside the try, so the refusal is published as the run\'s error');
  assert.match(fn, /keyRef: systemKeyRef\(id\)/);
  assert.doesNotMatch(src, /litellmKeyRef/, 'the old in-memory reference is gone from the run path');
});

test('ROTATION UNDER A RUN IN FLIGHT: the call that meets the old key is repeated once with the new one', async () => {
  const d = deployment();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_rot', adapters: makeLiveAdapters(d.build), probe: 'p' });
  d.asWorker();
  const before = (await resolveSystemKey('sys_rot')).key; // the worker now holds the old key in memory
  // The web process rotates. The worker's cached copy is NOT told (it is another process): put the
  // new record in the shared database and swap the key at the gateway directly.
  const fresh = mintSystemKey();
  const model = config.litellmToolsModel;
  await d.gw.admin.deleteKey(tokenIdOf(before));
  await d.gw.admin.generateKey({ systemId: 'sys_rot', alias: 'os-sys_rot', models: [model], maxBudget: 5, budgetDuration: '7d', modelMaxBudget: {}, rpmLimit: 300, tpmLimit: 1, maxParallelRequests: 8, allowedTools: [] }, fresh);
  await d.build.keys.store.put(sealSystemKey({ systemId: 'sys_rot', alias: 'os-sys_rot', key: fresh, caps: { models: [model], maxBudget: 5, budgetDuration: '7d', rpmLimit: 300, tpmLimit: 1, maxParallelRequests: 8 }, createdAt: 1, rotatedAt: 2 }, deploymentKek()));

  const call = liteLlmCaller({ userId: 'u1', domain: 'sales', systemId: 'sys_rot', keyRef: systemKeyRef('sys_rot') });
  const out = await withGateway(d.gw, () => call({ model, messages: [{ role: 'user', content: 'ping' }] }));
  assert.match(out.content ?? '', /nothing to report/);
  assert.deepEqual(d.gw.calls.map((c) => [c.bearer === before ? 'old' : c.bearer === fresh ? 'new' : 'other', c.status]), [['old', 401], ['new', 200]]);
  __setSystemKeyStoreForTests(null);
});

test('ROTATION through the admin action: the next run uses the new key and the old value is refused', async () => {
  const d = deployment();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_rot2', adapters: makeLiveAdapters(d.build), probe: 'p' });
  d.asWorker();
  const before = (await resolveSystemKey('sys_rot2', { fresh: true })).key;
  const out = await rotateSystemKeyWith('sys_rot2', YAML, d.build);
  assert.equal(out.ok, true, out.error ?? '');
  d.asWorker();
  const after = (await resolveSystemKey('sys_rot2')).key;
  assert.notEqual(after, before);
  const events: unknown[] = [];
  await withGateway(d.gw, () => runOnce('sys_rot2', events));
  assert.ok(d.gw.calls.every((c) => c.bearer === after && c.status === 200));
  assert.equal([...d.gw.keys.values()].some((k) => k.tokenId === tokenIdOf(before)), false, 'the old key is gone from the gateway');
  __setSystemKeyStoreForTests(null);
});

test('A KEY THE GATEWAY NO LONGER KNOWS (swept, not yet rebuilt) is an explicit error — and still never the shared key', async () => {
  const d = deployment();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_gone', adapters: makeLiveAdapters(d.build), probe: 'p' });
  d.asWorker();
  const own = (await resolveSystemKey('sys_gone')).key;
  await d.gw.admin.deleteKey(tokenIdOf(own));
  __setRotationWaitForTests(0);
  const call = liteLlmCaller({ userId: 'u1', domain: 'sales', systemId: 'sys_gone', keyRef: systemKeyRef('sys_gone') });
  await withGateway(d.gw, () => assert.rejects(
    call({ model: config.litellmToolsModel, messages: [{ role: 'user', content: 'ping' }] }),
    (e: unknown) => e instanceof SystemKeyRefusedError && e.code === 'system_key_rejected' && /Press Rebuild/.test(e.message) && !e.message.includes(own),
  ));
  assert.ok(d.gw.calls.every((c) => c.bearer === own), 'no other credential was tried');
  __setRotationWaitForTests(2000);
  __setSystemKeyStoreForTests(null);
});

test('A MODEL NOT ON THE KEY (a role re-pointed, or a fallback added, since the build) names the model and says Rebuild', async () => {
  const d = deployment();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_model', adapters: makeLiveAdapters(d.build), probe: 'p' });
  d.asWorker();
  const call = liteLlmCaller({ userId: 'u1', domain: 'sales', systemId: 'sys_model', keyRef: systemKeyRef('sys_model') });
  await withGateway(d.gw, () => assert.rejects(
    call({ model: 'a-model-added-later', messages: [{ role: 'user', content: 'ping' }] }),
    (e: unknown) => e instanceof SystemKeyRefusedError && e.code === 'system_key_model_not_allowed' && /"a-model-added-later"/.test(e.message) && /Press Rebuild/.test(e.message),
  ));
  assert.equal(d.gw.calls.length, 1, 'not retried: the same key would be refused again');
  __setSystemKeyStoreForTests(null);
});

test('WHAT get_agent_system RETURNS (the system view) after a build carries no key — the key lives only in the key store', async () => {
  const store = await import('@tabs/agents/lib/store');
  const owner = { id: 'amir', domains: ['sales'], role: 'creator' as const };
  const rec = store.createSystem(owner, { name: 'Key leak probe' });
  const d = deployment();
  const report = await orchestrateBuild({ yaml: store.getSystem(rec.id, owner).yaml, systemId: rec.id, adapters: makeLiveAdapters(d.build), probe: 'p' });
  assert.equal(report.rows.find((r) => r.tool === 'litellm')!.status, 'ok', JSON.stringify(report.rows));
  // Exactly what the build route persists, and exactly what `get_agent_system` spreads into its answer.
  store.setLastBuild(rec.id, owner, { ok: report.ok, at: 1, rows: report.rows });
  d.asWorker();
  const key = (await resolveSystemKey(rec.id)).key;
  const view = JSON.stringify(store.getSystem(rec.id, owner));
  assert.ok(!view.includes(key));
  assert.doesNotMatch(view, /sk-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(view, /litellmKeyRef|ciphertext|tokenId/, 'no key reference or key-store field on the system record');
  __setSystemKeyStoreForTests(null);
});

test('THE DERIVABLE KEY IS GONE FROM THE CODE: nothing builds a key from a system id, and the build route stores no key', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const clients = read('./live-clients.ts');
  assert.doesNotMatch(clients, /agentKeyValue|function keyValue|`sk-\$\{/, 'a key value is derived from a name again');
  const route = read('../../../../app/api/agents/systems/[id]/build/route.ts');
  assert.doesNotMatch(route, /putSecret|agentKeyValue|litellmKeyRef/, 'the build route handles a key again');
});
