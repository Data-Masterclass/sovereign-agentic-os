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
  makeLiveAdapters,
} from '@tabs/agents/lib/build/live';

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

function fakeLitellm(): LiteLlmClient & { keys: Map<string, unknown> } {
  const keys = new Map<string, unknown>();
  return {
    keys,
    async keyInfo(alias) {
      return (keys.get(alias) as { models: string[] } | undefined) ?? null;
    },
    async generateKey(input) {
      keys.set(input.alias, { models: input.models, maxBudget: input.maxBudget });
      return { key: `sk-${input.alias}` };
    },
    async models() {
      return ['sovereign-default', 'stackit-qwen3-vl-reasoning', 'stackit-qwen3-vl', 'sovereign-mock'];
    },
  };
}

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
  const info = (await d.litellm.keyInfo('os-sys_live')) as { models: string[]; maxBudget: number };
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
