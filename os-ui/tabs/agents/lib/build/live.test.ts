/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { type Decision } from '@tabs/agents/lib/gateway';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import {
  type OpaClient,
  type LiteLlmClient,
  type LangfuseClient,
  type LiveDeps,
  type LiteLlmKeyInput,
  type LiteLlmKeyState,
  DEFAULT_KEY_CAPS,
  keyDrift,
  makeLiveAdapters,
  parseGatewayFallbacks,
  withFallbackTargets,
} from '@tabs/agents/lib/build/live';
import {
  deriveKek,
  isLegacyDerivedToken,
  legacyDerivedKey,
  memorySystemKeyStore,
  openSystemKey,
  tokenIdOf,
  type SystemKeyStore,
} from '@core/infra/agent-system-keys';
import { rotateSystemKeyWith, removeSystemKeyWith } from '@tabs/agents/lib/build/system-key-admin';

/**
 * Live-adapter unit tests run the REAL adapter logic against in-memory FAKES that
 * behave like OPA / LiteLLM / Langfuse — so apply→verify is genuinely exercised
 * (the cardinal rule: ✓ only when both pass) without any network or STACKIT.
 *
 * A5: there is no runtime fake any more. The `langgraph` adapter used to POST the compiled
 * IR to the Python `agent-runtime` `/reload` and then ask it for a test `/run`; it now
 * COMPILES the real StateGraph in this process (`compileVerify` → `buildGraph`), so the
 * adapter needs no injected client and the fake that pretended to be an interpreter is gone.
 * The Langfuse row is consequently `pending` after a build — honestly, because its probe
 * reads the traces a RUN leaves behind and a build no longer performs one.
 */

const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: supervisor
grants:
  tools: [retrieve, write_file]
  connections:
    - { id: crm, capability: Read }
    - { id: crm_write, capability: Write-approval }
agents:
  - { id: supervisor, role: r, agent_md: "# Supervisor", memory_md: "# Mem", members: [worker], tools: [retrieve] }
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [write_file], model: sovereign-default }
edges:
  - { from: supervisor, to: worker, type: supervise }
`;

// --------------------------------------------------------------- fakes ----------

function fakeOpa(): OpaClient & { grants: Map<string, Set<string>>; approval: Set<string> } {
  const grants = new Map<string, Set<string>>();
  const approval = new Set<string>();
  return {
    grants,
    approval,
    async putGrants(principal, tools) {
      grants.set(principal, new Set(tools));
    },
    async mergeRequiresApproval(tools) {
      for (const t of tools) approval.add(t);
    },
    async decision(principal, tool): Promise<Decision> {
      const has = grants.get(principal)?.has(tool) ?? false;
      if (!has) return { effect: 'deny', reason: 'not granted' };
      if (approval.has(tool)) return { effect: 'requires_approval', reason: 'high-stakes' };
      return { effect: 'allow', reason: 'granted' };
    },
  };
}

type FakeKey = LiteLlmKeyState & { updates: number };

/**
 * A LiteLLM that behaves like the real one where it matters here: a key is addressed by its token
 * id (the SHA-256 of the value), an alias is UNIQUE (`/key/generate` refuses a second key under
 * it), and a deleted key is gone. `values` records every key VALUE it was ever given, so a test
 * can assert what the OS sent; `deleted` the token ids it was asked to remove.
 */
function fakeLitellm(): LiteLlmClient & { keys: Map<string, FakeKey>; generated: number; values: string[]; deleted: string[] } {
  const keys = new Map<string, FakeKey>();
  const store = (input: LiteLlmKeyInput, tokenId: string, updates: number): FakeKey => ({
    tokenId,
    models: [...input.models],
    maxBudget: input.maxBudget,
    budgetDuration: input.budgetDuration,
    rpmLimit: input.rpmLimit,
    tpmLimit: input.tpmLimit,
    maxParallelRequests: input.maxParallelRequests,
    allowedTools: [...input.allowedTools],
    updates,
  });
  const client = {
    keys,
    generated: 0,
    values: [] as string[],
    deleted: [] as string[],
    async keysByAlias(alias: string) {
      const k = keys.get(alias);
      return k ? [k] : [];
    },
    async generateKey(input: LiteLlmKeyInput, key: string) {
      if (!key.startsWith('sk-')) throw new Error('LiteLLM /key/generate failed (400)');
      if (keys.has(input.alias)) throw new Error(`LiteLLM /key/generate failed (400) — Key with alias '${input.alias}' already exists`);
      client.generated += 1;
      client.values.push(key);
      keys.set(input.alias, store(input, tokenIdOf(key), 0));
    },
    async updateKey(tokenId: string, input: LiteLlmKeyInput) {
      const cur = [...keys.entries()].find(([, k]) => k.tokenId === tokenId);
      if (!cur) throw new Error('LiteLLM /key/update failed (404)');
      keys.set(cur[0], store(input, tokenId, cur[1].updates + 1));
    },
    async deleteKey(tokenId: string) {
      client.deleted.push(tokenId);
      for (const [alias, k] of keys) if (k.tokenId === tokenId) keys.delete(alias);
    },
    async models() {
      return ['sovereign-default', 'stackit-qwen3-vl-reasoning', 'stackit-qwen3-vl', 'sovereign-mock'];
    },
  };
  return client;
}

/** The key-encryption key every fake deployment in this file uses. */
const KEK = deriveKek('unit-test-key-encryption-secret-0123456789');

function fakeLangfuse(): LangfuseClient & { projects: Set<string>; traces: Map<string, number> } {
  const projects = new Set<string>();
  const traces = new Map<string, number>();
  return {
    projects,
    traces,
    async ensureProject(name) {
      projects.add(name);
    },
    async tracesFor(principal) {
      return traces.get(principal) ?? 0;
    },
  };
}

function deps(): LiveDeps & {
  opa: ReturnType<typeof fakeOpa>;
  litellm: ReturnType<typeof fakeLitellm>;
  langfuse: ReturnType<typeof fakeLangfuse>;
} {
  const opa = fakeOpa();
  const langfuse = fakeLangfuse();
  return {
    opa,
    litellm: fakeLitellm(),
    langfuse,
    keys: { store: memorySystemKeyStore(), kek: () => KEK },
  };
}

// --------------------------------------------------------------- tests ----------

test('the live adapters build all-green against the fakes (Langfuse pending until a run)', async () => {
  const d = deps();
  const report = await orchestrateBuild({
    yaml: YAML,
    systemId: 'sys_live',
    adapters: makeLiveAdapters(d),
    probe: 'gate probe',
  });
  assert.equal(report.ok, true, JSON.stringify(report.rows, null, 2));
  assert.deepEqual(report.rows.map((r) => r.tool).sort(), ['langfuse', 'langgraph', 'litellm', 'opa']);
  for (const r of report.rows) assert.notEqual(r.status, 'fail', `${r.tool}: ${r.error ?? ''}`);
  // Langfuse is the one NEUTRAL row: its probe reads the traces a RUN produced, and a build
  // no longer fakes a run to manufacture them.
  const byTool = new Map(report.rows.map((r) => [r.tool, r]));
  for (const t of ['opa', 'litellm', 'langgraph']) assert.equal(byTool.get(t)!.status, 'ok', t);
  assert.match(byTool.get('langfuse')!.detail, /run the agent once/);
});

test('opa grants the system principal + holds the write tool for approval', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const g = d.opa.grants.get('os-sys_live')!;
  assert.ok(g.has('retrieve'), 'granted tool present');
  // Raw legacy grants ALSO resolve into their sanctioned MCP registry names, so a
  // Build authorizes the same vocabulary the Run path resolves to (raw ∪ resolved).
  assert.ok(g.has('search_knowledge'), 'legacy retrieve grant resolved into its MCP name');
  assert.ok(g.has('upload_file'), 'legacy write_file grant resolved into its MCP name');
  assert.equal((await d.opa.decision('os-sys_live', 'search_knowledge')).effect, 'allow');
  assert.ok(g.has('connection_crm'), 'enabled connection present');
  assert.ok(g.has('connection_crm_write'), 'write connection granted');
  assert.ok(d.opa.approval.has('connection_crm_write'), 'write connection held for approval');
  assert.equal((await d.opa.decision('os-sys_live', 'retrieve')).effect, 'allow');
  assert.equal((await d.opa.decision('os-sys_live', 'connection_crm_write')).effect, 'requires_approval');
  assert.equal((await d.opa.decision('os-sys_live', 'connection_ghost')).effect, 'deny');
});

test('litellm registers a scoped key (alias os-<id>) with budget caps + routed models', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const info = d.litellm.keys.get('os-sys_live')!;
  assert.ok(info, 'key registered under the system alias');
  assert.ok(info.models.includes('sovereign-default'), 'light/standard tier model allowed');
  assert.ok(info.models.some((m) => /sovereign-reasoning/i.test(m)), 'reasoning tier model allowed');
  const litellm = (await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' })).rows.find((r) => r.tool === 'litellm')!;
  assert.match(litellm.detail.toLowerCase(), /sovereign-default/);
  assert.match(litellm.detail.toLowerCase(), /sovereign-reasoning/);
});

test('litellm apply is idempotent (an already-provisioned key is not regenerated)', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const before = d.litellm.keys.get('os-sys_live');
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  assert.strictEqual(d.litellm.keys.get('os-sys_live'), before, 'key object unchanged on re-build');
});

test('langgraph COMPILES the real StateGraph and reports its node set, budget and warnings', async () => {
  const d = deps();
  const report = await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const row = report.rows.find((r) => r.tool === 'langgraph')!;
  assert.equal(row.status, 'ok', row.error ?? '');
  const ir = compile(parseSystem(YAML));
  assert.match(row.detail, new RegExp(`${ir.nodes.length * 4} graph node\\(s\\)`), 'four LangGraph nodes per agent');
  assert.match(row.detail, /recursion limit \d+/);
});

test('langgraph FAILS the build when the graph cannot be compiled (an unmapped legacy grant)', async () => {
  const d = deps();
  const report = await orchestrateBuild({
    yaml: YAML.replace('tools: [retrieve, write_file]', 'tools: [retrieve, web_fetch]').replace('tools: [write_file]', 'tools: [web_fetch]'),
    systemId: 'sys_unmapped',
    adapters: makeLiveAdapters(d),
    probe: 'p',
  });
  const row = report.rows.find((r) => r.tool === 'langgraph')!;
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /web_fetch/, 'the build names the grant that has no governed tool');
  assert.equal(report.ok, false);
});

test('langfuse ensures the project; its verify is PENDING with no run, and ✓ once a run has traced', async () => {
  const d = deps();
  const first = await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  assert.ok(d.langfuse.projects.has('os-sys_live'));
  assert.equal(await d.langfuse.tracesFor('os-sys_live'), 0, 'a build performs no run, so it leaves no trace');
  assert.match(first.rows.find((r) => r.tool === 'langfuse')!.detail, /run the agent once/);

  // A real run traces every governed tool call; the next build reports it.
  d.langfuse.traces.set('os-sys_live', 3);
  const second = await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const row = second.rows.find((r) => r.tool === 'langfuse')!;
  assert.equal(row.status, 'ok');
  assert.match(row.detail, /3 trace\(s\)/);
});

test('CARDINAL RULE — a failing verify surfaces ✗ (opa grants silently dropped)', async () => {
  const d = deps();
  // apply "succeeds" but writes nothing, so the verify probe cannot resolve the
  // granted tool → the row must read ✗ and the whole build must fail.
  d.opa.putGrants = async () => {};
  const report = await orchestrateBuild({ yaml: YAML, systemId: 'sys_bad', adapters: makeLiveAdapters(d), probe: 'p' });
  const opa = report.rows.find((r) => r.tool === 'opa')!;
  assert.equal(opa.status, 'fail');
  assert.equal(report.ok, false);
});

// ------------------------------------------ the system's own key is RECONCILED ----

const build = (d: LiveDeps) => orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
const keyRow = async (d: LiveDeps) => (await build(d)).rows.find((r) => r.tool === 'litellm')!;

test('key ABSENT: the build creates it with the configured caps and says "created"', async () => {
  const d = deps();
  const row = await keyRow(d);
  assert.equal(row.status, 'ok', row.error ?? '');
  assert.equal(row.change, 'created');
  assert.match(row.appliedDetail ?? '', /created key 'os-sys_live' — \d+ model\(s\), budget \$5 per 7d, 300 requests\/min, 1000000 tokens\/min/);
  const key = d.litellm.keys.get('os-sys_live')!;
  assert.equal(key.tpmLimit, 1_000_000);
  assert.equal(key.rpmLimit, 300);
  assert.equal(key.budgetDuration, '7d', 'the budget resets weekly by default — never a lifetime cap');
  assert.equal(d.litellm.generated, 1);
});

test('key EQUAL: a rebuild writes nothing and says "already up to date"', async () => {
  const d = deps();
  await build(d);
  const row = await keyRow(d);
  assert.equal(row.status, 'ok');
  assert.equal(row.change, 'unchanged');
  assert.match(row.appliedDetail ?? '', /already up to date/);
  assert.equal(d.litellm.generated, 1, 'not regenerated');
  assert.equal(d.litellm.keys.get('os-sys_live')!.updates, 0, 'not updated');
});

test('key DRIFTED (the old hard-coded caps): a rebuild updates it and says exactly what changed', async () => {
  const d = deps();
  // A key as every system built before this change holds it: 200k tokens/min, 120 rpm, a $5 LIFETIME budget.
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters({ ...d, caps: { maxBudget: 5, budgetDuration: '', modelMaxBudget: {}, rpmLimit: 120, tpmLimit: 200_000, maxParallelRequests: 8 } }), probe: 'p' });
  assert.equal(d.litellm.keys.get('os-sys_live')!.tpmLimit, 200_000);

  const row = await keyRow(d); // now with the configured defaults
  assert.equal(row.status, 'ok', row.error ?? '');
  assert.equal(row.change, 'updated');
  assert.equal(row.appliedDetail, "updated key 'os-sys_live': budget reset none → 7d; requests/min 120 → 300; tokens/min 200000 → 1000000");
  const key = d.litellm.keys.get('os-sys_live')!;
  assert.deepEqual([key.tpmLimit, key.rpmLimit, key.budgetDuration, key.updates], [1_000_000, 300, '7d', 1]);
  assert.equal(d.litellm.generated, 1, 'the key is updated in place, never regenerated');

  // …and the build after that is a no-op again: reconciling is idempotent.
  assert.equal((await keyRow(d)).change, 'unchanged');
});

test('a changed DEFINITION reaches the key too: a newly routed model is added to the allowlist', async () => {
  const d = deps();
  await build(d);
  const report = await orchestrateBuild({ yaml: YAML.replace('model: sovereign-default', 'model: sovereign-vision'), systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const row = report.rows.find((r) => r.tool === 'litellm')!;
  assert.equal(row.change, 'updated');
  assert.match(row.appliedDetail ?? '', /models .* → .*sovereign-vision/);
  assert.ok(d.litellm.keys.get('os-sys_live')!.models.includes('sovereign-vision'));
});

test('an update the gateway REFUSES is a failed build row, not a silent ok', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters({ ...d, caps: { ...DEFAULT_KEY_CAPS, tpmLimit: 200_000 } }), probe: 'p' });
  d.litellm.updateKey = async () => { throw new Error('LiteLLM /key/update failed (500) — the key keeps its previous limits'); };
  const report = await build(d);
  const row = report.rows.find((r) => r.tool === 'litellm')!;
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /\/key\/update failed \(500\)/);
  assert.equal(report.ok, false);
  assert.equal(d.litellm.keys.get('os-sys_live')!.tpmLimit, 200_000, 'the key really is unchanged');
});

test('an update the gateway ACCEPTS but does not store fails VERIFY — the read-back is the proof', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters({ ...d, caps: { ...DEFAULT_KEY_CAPS, tpmLimit: 200_000 } }), probe: 'p' });
  d.litellm.updateKey = async () => {};
  const row = await keyRow(d);
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /does not match the definition after the build: tokens\/min 200000 → 1000000/);
});

test('every build row says what apply DID, so a fast rebuild is understandable', async () => {
  const d = deps();
  await build(d);
  const rows = new Map((await build(d)).rows.map((r) => [r.tool, r.change]));
  assert.deepEqual(Object.fromEntries(rows), { opa: 'reapplied', litellm: 'unchanged', langgraph: 'reapplied', langfuse: 'unchanged' });
});

test('keyDrift: equal is empty; a gateway that does not report allowed tools is not drift', () => {
  const want: LiteLlmKeyInput = { systemId: 'x', alias: 'os-x', models: ['b', 'a'], maxBudget: 5, budgetDuration: '7d', modelMaxBudget: {}, rpmLimit: 300, tpmLimit: 1_000_000, maxParallelRequests: 8, allowedTools: ['t'] };
  assert.deepEqual(keyDrift({ models: ['a', 'b'], maxBudget: 5, budgetDuration: '7d', rpmLimit: 300, tpmLimit: 1_000_000, maxParallelRequests: 8 }, want), []);
  assert.deepEqual(keyDrift({ models: ['a', 'b'], maxBudget: 5, budgetDuration: '7d', rpmLimit: 300, tpmLimit: 1_000_000, maxParallelRequests: 8, allowedTools: [] }, want), ['allowed tools 0 → 1']);
  // A key made before `max_parallel_requests` was set has none: that IS drift, and a rebuild sets it.
  assert.deepEqual(keyDrift({ models: ['a', 'b'], maxBudget: 5, budgetDuration: '7d', rpmLimit: 300, tpmLimit: 1_000_000 }, want), ['calls at once none → 8']);
});

// ---------------------------------- the key is RANDOM, STORED ENCRYPTED, and REPLACEABLE ----

/** The stored key of a system, decrypted the way the run path does it. */
async function storedValue(store: SystemKeyStore, systemId: string): Promise<string> {
  const record = await store.get(systemId);
  assert.ok(record, `no stored key for ${systemId}`);
  return openSystemKey(record, KEK);
}

/** A gateway that already holds the key every system built BEFORE this change has: `sk-os-<id>`. */
function withLegacyKey(d: ReturnType<typeof deps>, systemId = 'sys_live') {
  const alias = `os-${systemId}`;
  d.litellm.keys.set(alias, { tokenId: tokenIdOf(legacyDerivedKey(alias)), models: ['sovereign-default'], maxBudget: 5, budgetDuration: '', rpmLimit: 120, tpmLimit: 200_000, updates: 0 });
  return tokenIdOf(legacyDerivedKey(alias));
}

test('RANDOM: the key Build registers is never derived from the system id, and two systems never share one', async () => {
  const d = deps();
  await build(d);
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_other', adapters: makeLiveAdapters(d), probe: 'p' });
  const [a, b] = d.litellm.values;
  assert.equal(d.litellm.values.length, 2);
  for (const [key, id] of [[a, 'sys_live'], [b, 'sys_other']] as const) {
    assert.match(key, /^sk-[A-Za-z0-9_-]{43}$/, 'sk- + 32 random bytes, base64url');
    assert.notEqual(key, `sk-os-${id}`, 'never the derivable value');
    assert.ok(!key.includes(id), 'the system id is not part of the key');
    assert.equal(isLegacyDerivedToken(`os-${id}`, tokenIdOf(key)), false);
  }
  assert.notEqual(a, b);
});

test('STORED: the registered key is the one the run path reads back from the store — and the alias stays os-<id>', async () => {
  const d = deps();
  await build(d);
  const value = await storedValue(d.keys.store, 'sys_live');
  assert.equal(value, d.litellm.values[0], 'the store holds exactly the key the gateway was given');
  assert.equal(d.litellm.keys.get('os-sys_live')!.tokenId, tokenIdOf(value));
  const record = (await d.keys.store.get('sys_live'))!;
  assert.equal(record.alias, 'os-sys_live');
  assert.equal(record.rotatedAt, null, 'a first key was never rotated');
  assert.ok(!JSON.stringify(record).includes(value), 'the stored record carries ciphertext, never the value');
});

test('MIGRATION: a system holding the old guessable key gets a NEW random key and the old one is DELETED at the gateway', async () => {
  const d = deps();
  const legacyToken = withLegacyKey(d);
  const row = await keyRow(d);
  assert.equal(row.status, 'ok', row.error ?? '');
  assert.equal(row.change, 'updated');
  assert.match(row.appliedDetail ?? '', /could be derived from the system id; it was deleted at the gateway and replaced by a random key/);
  assert.deepEqual(d.litellm.deleted, [legacyToken], 'the guessable key no longer works');
  const now = d.litellm.keys.get('os-sys_live')!;
  assert.notEqual(now.tokenId, legacyToken);
  assert.equal(now.tpmLimit, 1_000_000, 'the new key has the configured caps, not the old ones');
  assert.equal(await storedValue(d.keys.store, 'sys_live'), d.litellm.values[0]);
  // …and the rebuild after that changes nothing: one Rebuild is enough.
  assert.equal((await keyRow(d)).change, 'unchanged');
  assert.equal(d.litellm.generated, 1);
});

test('LOST COPY: a key at the gateway with no readable stored copy is replaced (a different encryption secret, or no record)', async () => {
  const d = deps();
  await build(d);
  const first = d.litellm.keys.get('os-sys_live')!.tokenId;
  // Another deployment secret: the stored record can no longer be decrypted.
  const other = { ...d, keys: { ...d.keys, kek: () => deriveKek('a-different-key-encryption-secret-98765') } };
  const row = (await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(other), probe: 'p' })).rows.find((r) => r.tool === 'litellm')!;
  assert.equal(row.status, 'ok', row.error ?? '');
  assert.match(row.appliedDetail ?? '', /no readable stored copy/);
  assert.deepEqual(d.litellm.deleted, [first]);
  assert.notEqual(d.litellm.keys.get('os-sys_live')!.tokenId, first);
});

test('ROTATION (mint new, swap, delete old): the value changes, the alias and the caps stay, the old value stops working', async () => {
  const d = deps();
  await build(d);
  const before = await storedValue(d.keys.store, 'sys_live');
  const out = await rotateSystemKeyWith('sys_live', YAML, d);
  assert.equal(out.ok, true, out.error ?? '');
  assert.match(out.row?.appliedDetail ?? '', /rotated on request/);
  const after = await storedValue(d.keys.store, 'sys_live');
  assert.notEqual(after, before);
  assert.deepEqual(d.litellm.deleted, [tokenIdOf(before)], 'the old key was deleted at the gateway');
  assert.equal(d.litellm.keys.get('os-sys_live')!.tokenId, tokenIdOf(after), 'the alias now names the new key');
  assert.equal(d.litellm.keys.size, 1, 'never two keys for one system');
  const record = (await d.keys.store.get('sys_live'))!;
  assert.ok(record.rotatedAt !== null && record.rotatedAt >= record.createdAt, 'the rotation is dated; the first issue date is kept');
});

test('A FAILED REPLACEMENT is honest: no new key ⇒ the stored record goes too, and the row fails', async () => {
  const d = deps();
  await build(d);
  d.litellm.generateKey = async () => { throw new Error('LiteLLM /key/generate failed (500)'); };
  const out = await rotateSystemKeyWith('sys_live', YAML, d);
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /NO model key now; press Build again/);
  assert.equal(await d.keys.store.get('sys_live'), null, 'no record that points at a key the gateway does not have');
});

test('A key that cannot be STORED is taken out of the gateway again — never a key nobody can read', async () => {
  const d = deps();
  d.keys.store.put = async () => { throw new Error('database down'); };
  const row = await keyRow(d);
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /could not be stored \(database down\).*removed from the gateway again/);
  assert.equal(d.litellm.keys.size, 0);
});

test('NO ENCRYPTION SECRET: the build fails on the key row and registers nothing', async () => {
  const d = deps();
  const row = (await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters({ ...d, keys: { ...d.keys, kek: () => deriveKek('') } }), probe: 'p' })).rows.find((r) => r.tool === 'litellm')!;
  assert.equal(row.status, 'fail');
  assert.match(row.error ?? '', /AGENT_KEY_ENCRYPTION_KEY/);
  assert.equal(d.litellm.generated, 0);
});

test('A gateway that cannot be READ is not mistaken for "no key": nothing is minted', async () => {
  const d = deps();
  d.litellm.keysByAlias = async () => { throw new Error('LiteLLM /key/list failed (unreachable)'); };
  const row = await keyRow(d);
  assert.equal(row.status, 'fail');
  assert.equal(d.litellm.generated, 0);
});

test('ALLOWLIST: the key allows the run\'s role models (the plan step\'s reasoning model) and every gateway fallback target', async () => {
  const d = deps();
  const fallbacks = parseGatewayFallbacks(JSON.stringify({
    fallbacks: { 'sovereign-default': ['sovereign-premium'], 'sovereign-reasoning': ['sovereign-reasoning-fast'], 'sovereign-reasoning-fast': ['sovereign-last-resort'] },
    default: ['sovereign-catch-all'],
  }));
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters({ ...d, runModels: () => ['role-reasoning-model', 'role-tools-model'], fallbacks }), probe: 'p' });
  const models = d.litellm.keys.get('os-sys_live')!.models;
  for (const m of ['sovereign-default', 'sovereign-reasoning', 'role-reasoning-model', 'role-tools-model', 'sovereign-premium', 'sovereign-reasoning-fast', 'sovereign-last-resort', 'sovereign-catch-all']) {
    assert.ok(models.includes(m), `${m} is missing from the key's model list (${models.join(', ')})`);
  }
  assert.equal(d.litellm.keys.get('os-sys_live')!.maxParallelRequests, 8, 'max_parallel_requests is set on a system key');
});

test('withFallbackTargets / parseGatewayFallbacks: transitive, cycle-safe, and empty means "none", text that is not JSON throws', () => {
  assert.deepEqual(withFallbackTargets(['a'], { fallbacks: { a: ['b'], b: ['a', 'c'] }, default: [] }).sort(), ['a', 'b', 'c']);
  assert.deepEqual(withFallbackTargets(['a'], undefined), ['a']);
  assert.throws(() => parseGatewayFallbacks('not json'), /AGENT_SYSTEM_KEY_FALLBACKS_JSON is not valid JSON/);
  assert.deepEqual(parseGatewayFallbacks(''), { fallbacks: {}, default: [] });
  assert.deepEqual(parseGatewayFallbacks('{"fallbacks":{"a":["b",3]},"default":"x"}'), { fallbacks: { a: ['b'] }, default: [] });
});

test('an `auto` model pin is the engine\'s sentinel, not a model on the key', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML.replace('model: sovereign-default', 'model: auto'), systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  assert.ok(!d.litellm.keys.get('os-sys_live')!.models.includes('auto'));
});

test('DELETING a system removes its key at the gateway and from the store', async () => {
  const d = deps();
  await build(d);
  const token = d.litellm.keys.get('os-sys_live')!.tokenId;
  const out = await removeSystemKeyWith('sys_live', d);
  assert.equal(out.ok, true, out.detail);
  assert.deepEqual(d.litellm.deleted, [token]);
  assert.equal(await d.keys.store.get('sys_live'), null);
});

test('NO KEY IN THE OUTPUT: the build report and the rotation outcome carry no key value', async () => {
  const d = deps();
  const first = await build(d);
  const rotated = await rotateSystemKeyWith('sys_live', YAML, d);
  const text = JSON.stringify([first, rotated]);
  for (const value of d.litellm.values) assert.ok(!text.includes(value), 'a key value reached the build output');
  assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{20,}/, 'nothing shaped like a key in the build output');
});
