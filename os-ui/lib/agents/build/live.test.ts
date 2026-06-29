/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { type Decision } from '../gateway.ts';
import { orchestrateBuild } from './orchestrate.ts';
import {
  type ForgejoClient,
  type OpaClient,
  type LiteLlmClient,
  type RuntimeClient,
  type LangfuseClient,
  type LiveDeps,
  makeLiveAdapters,
} from './live.ts';
import { type ReloadRequest, type RunRequest, type RunResponse } from './runtime-contract.ts';

/**
 * Live-adapter unit tests run the REAL adapter logic against in-memory FAKES that
 * behave like Forgejo / OPA / LiteLLM / the runtime / Langfuse — so apply→verify
 * is genuinely exercised (the cardinal rule: ✓ only when both pass) without any
 * network or STACKIT.
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
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [write_file], model: ministral-3 }
edges:
  - { from: supervisor, to: worker, type: supervise }
`;

// --------------------------------------------------------------- fakes ----------

function fakeForgejo(): ForgejoClient & { files: Map<string, { content: string; sha: string }> } {
  const files = new Map<string, { content: string; sha: string }>();
  const sha = (c: string) => String(c.length) + ':' + c.slice(0, 4);
  return {
    files,
    async ensureRepo() {},
    async readFile(_repo, path) {
      return files.get(path) ?? null;
    },
    async writeFile(_repo, path, content) {
      const rec = { content, sha: sha(content) };
      files.set(path, rec);
      return { sha: rec.sha };
    },
  };
}

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
      return ['ministral-3', 'stackit-qwen3-vl-reasoning', 'stackit-qwen3-vl', 'sovereign-mock'];
    },
  };
}

/** A runtime fake that walks the IR like the real interpreter would. */
function fakeRuntime(opa: OpaClient): RuntimeClient & { reloaded: Map<string, ReloadRequest> } {
  const reloaded = new Map<string, ReloadRequest>();
  return {
    reloaded,
    async reload(req: ReloadRequest) {
      reloaded.set(req.systemId, req);
      return { ok: true, systemId: req.systemId, nodes: req.ir.nodes.length, entrypoint: req.ir.entrypoint };
    },
    async run(req: RunRequest): Promise<RunResponse> {
      const r = reloaded.get(req.systemId);
      if (!r) return { ok: false, reachedEnd: false, path: [], steps: [], traces: 0, error: 'system not reloaded' };
      const ir = r.ir;
      const path: string[] = [];
      const steps: RunResponse['steps'] = [];
      const principal = `os-${req.systemId}`;
      for (const n of ir.nodes) {
        if (req.disabledAgents.includes(n.id)) continue;
        path.push(n.id);
        for (const tool of n.tools) {
          const d = await opa.decision(principal, tool);
          steps.push({ node: n.id, tool, effect: d.effect, ran: d.effect === 'allow' });
        }
      }
      return { ok: true, reachedEnd: true, path, steps, traces: steps.length, output: 'ok' };
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
  forgejo: ReturnType<typeof fakeForgejo>;
  opa: ReturnType<typeof fakeOpa>;
  litellm: ReturnType<typeof fakeLitellm>;
  langfuse: ReturnType<typeof fakeLangfuse>;
} {
  const opa = fakeOpa();
  const langfuse = fakeLangfuse();
  const runtime = fakeRuntime(opa);
  // Wire the langgraph run's traces into Langfuse the way os-ui does (every
  // governed tool call traced). The runtime fake doesn't trace; simulate it by
  // counting after the run via a wrapper.
  const tracedRuntime: RuntimeClient = {
    reload: runtime.reload,
    async run(req) {
      const res = await runtime.run(req);
      langfuse.traces.set(`os-${req.systemId}`, (langfuse.traces.get(`os-${req.systemId}`) ?? 0) + res.traces);
      return res;
    },
  };
  return {
    forgejo: fakeForgejo(),
    opa,
    litellm: fakeLitellm(),
    runtime: tracedRuntime,
    langfuse,
  };
}

// --------------------------------------------------------------- tests ----------

test('the 5 live adapters build all-green against the fakes', async () => {
  const d = deps();
  const report = await orchestrateBuild({
    yaml: YAML,
    systemId: 'sys_live',
    adapters: makeLiveAdapters(d),
    probe: 'gate probe',
  });
  assert.equal(report.ok, true, JSON.stringify(report.rows, null, 2));
  assert.deepEqual(report.rows.map((r) => r.tool).sort(), ['forgejo', 'langfuse', 'langgraph', 'litellm', 'opa']);
  for (const r of report.rows) assert.equal(r.status, 'ok', `${r.tool}: ${r.error ?? ''}`);
});

test('forgejo wrote system.yaml + per-agent files and verify round-trips parseSystem', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  assert.ok(d.forgejo.files.has('system.yaml'));
  assert.ok(d.forgejo.files.has('agents/worker/AGENT.md'));
  assert.ok(d.forgejo.files.has('agents/supervisor/MEMORY.md'));
  assert.doesNotThrow(() => parseSystem(d.forgejo.files.get('system.yaml')!.content));
});

test('opa grants the system principal + holds the write tool for approval', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const g = d.opa.grants.get('os-sys_live')!;
  assert.ok(g.has('retrieve'), 'granted tool present');
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
  assert.ok(info.models.includes('ministral-3'), 'light tier model allowed');
  assert.ok(info.models.some((m) => /sovereign-reasoning/i.test(m)), 'reasoning tier model allowed');
  const litellm = (await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' })).rows.find((r) => r.tool === 'litellm')!;
  assert.match(litellm.detail.toLowerCase(), /ministral/);
  assert.match(litellm.detail.toLowerCase(), /sovereign-reasoning/);
});

test('litellm apply is idempotent (an already-provisioned key is not regenerated)', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const before = d.litellm.keys.get('os-sys_live');
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  assert.strictEqual(d.litellm.keys.get('os-sys_live'), before, 'key object unchanged on re-build');
});

test('langgraph reloads the compiled IR and the run reaches END with every tool governed', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  const reloaded = (d.runtime as unknown as { reloaded?: Map<string, ReloadRequest> }).reloaded;
  // reloaded map lives on the inner fake; assert via a fresh run instead:
  const res = await d.runtime.run({ systemId: 'sys_live', prompt: 'p', recursionLimit: 25, timeoutMs: 1000, disabledAgents: [] });
  assert.equal(res.reachedEnd, true);
  assert.ok(res.steps.length >= 2, 'each node tool produced a governed step');
  assert.ok(res.steps.every((s) => (s.effect === 'allow') === s.ran), 'ran iff allowed');
  void reloaded;
});

test('langfuse ensures the project and verify sees the run trace', async () => {
  const d = deps();
  await orchestrateBuild({ yaml: YAML, systemId: 'sys_live', adapters: makeLiveAdapters(d), probe: 'p' });
  assert.ok(d.langfuse.projects.has('os-sys_live'));
  assert.ok((await d.langfuse.tracesFor('os-sys_live')) > 0);
});

test('CARDINAL RULE — a failing verify surfaces ✗ (forgejo round-trip broken)', async () => {
  const d = deps();
  // Corrupt the repo read so verify cannot parse system.yaml back.
  const original = d.forgejo.writeFile.bind(d.forgejo);
  d.forgejo.writeFile = async (repo, path, content, sha) => {
    if (path === 'system.yaml') return original(repo, path, ': not : valid : yaml :', sha);
    return original(repo, path, content, sha);
  };
  const report = await orchestrateBuild({ yaml: YAML, systemId: 'sys_bad', adapters: makeLiveAdapters(d), probe: 'p' });
  const forgejo = report.rows.find((r) => r.tool === 'forgejo')!;
  assert.equal(forgejo.status, 'fail');
  assert.equal(report.ok, false);
});
