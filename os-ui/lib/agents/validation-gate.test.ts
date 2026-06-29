/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetStore,
  createSystem,
  getSystem,
  listFiles,
  readFile,
  writeFile,
  setRunning,
  setSchedule,
  toggleAgent,
  type Principal,
} from './store.ts';
import { type System, parseSystem, serializeSystem } from './system-schema.ts';
import { compile } from './langgraph-compile.ts';
import { addAgent, addSuperviseEdge } from './canvas-edit.ts';
import { applyInstruction } from './assistant.ts';
import { routeProbe } from './routing.ts';
import { orchestrateBuild } from './build/orchestrate.ts';
import { newMockBackends, makeMockAdapters, registerGrants, gatewayFor } from './build/mocks.ts';

/**
 * The Task-9 validation gate as an in-process integration test. It builds a
 * 2-agent system (supervisor + sub-agent) BOTH ways — by editor/canvas mutations
 * AND by asking the agent-system helper — committing through the SAME store file
 * write (one source). It then executes each into the mocked LangGraph / LiteLLM /
 * OPA / Langfuse adapters and asserts: verification passes; routing hits Ministral
 * (light) and STACKIT Qwen (reasoning); a granted connection works while a
 * non-granted one is blocked and a write is held for approval; and
 * run/schedule/toggle work. (Everything is mocked in-process per the locked
 * design — no STACKIT, no real kind workloads.)
 */

const user: Principal = { id: 'alex', domains: ['sales'], role: 'builder' };

/** Commit a mutated System through the SAME whitelisted, sha-checked file write
 *  the canvas, the Monaco panel and the agent-system chat all use. */
function commit(systemId: string, next: System): void {
  const cur = readFile(systemId, user, 'system.yaml');
  writeFile(systemId, user, { path: 'system.yaml', content: serializeSystem(next), sha: cur.sha });
}

function withConnections(sys: System): System {
  const next = structuredClone(sys);
  next.grants.connections = [
    { id: 'crm', capability: 'Read' },
    { id: 'crm_write', capability: 'Write-approval' },
  ];
  return next;
}

async function assertBuildsAndVerifies(systemId: string): Promise<void> {
  const view = getSystem(systemId, user);
  const backends = newMockBackends();
  const report = await orchestrateBuild({
    yaml: view.yaml,
    systemId,
    adapters: makeMockAdapters(backends),
    probe: 'gate probe',
  });
  assert.equal(report.ok, true, `Build should verify; rows: ${JSON.stringify(report.rows)}`);
  const tools = report.rows.map((r) => r.tool).sort();
  assert.deepEqual(tools, ['forgejo', 'langfuse', 'langgraph', 'litellm', 'opa']);
  for (const r of report.rows) assert.equal(r.status, 'ok', `${r.tool}: ${r.error ?? ''}`);
  // A trace landed for the test invocation (Langfuse verify only passes if so).
  assert.ok(backends.langfuse.traces.length > 0, 'a Langfuse trace must land for the test invocation');
}

test('GATE A — build a 2-agent supervisor+sub by editor/canvas; it executes + verifies', async () => {
  __resetStore();
  const rec = createSystem(user, { name: 'Gate A', domain: 'sales' });

  // Canvas/editor path: add a sub-agent and supervise it from the entrypoint.
  let sys = getSystem(rec.id, user).system;
  sys = addAgent(sys, { id: 'researcher', role: 'finds and cites facts' });
  sys = addSuperviseEdge(sys, sys.entrypoint, 'researcher');
  sys = withConnections(sys);
  commit(rec.id, sys);

  // The single source now holds a supervisor + sub-agent that compiles.
  const view = getSystem(rec.id, user).system;
  assert.equal(view.agents.length, 2);
  const sup = view.agents.find((a) => a.id === view.entrypoint)!;
  assert.deepEqual(sup.members, ['researcher']);
  assert.doesNotThrow(() => compile(view));

  // The per-agent files project from the one source (Forgejo whitelist).
  const files = listFiles(rec.id, user).files;
  assert.ok(files.includes('agents/researcher/AGENT.md'));

  await assertBuildsAndVerifies(rec.id);
});

test('GATE B — the agent-system helper builds the same kind of system from chat (same source)', async () => {
  __resetStore();
  // Seed a system whose entrypoint is an (empty) supervisor, so the helper can
  // attach a sub-agent under it — the realistic "ask the agent to build it" flow.
  const seed: System = {
    version: '1',
    system: { name: 'Gate B', domain: 'sales', visibility: 'Personal' },
    entrypoint: 'supervisor',
    state: { channels: { messages: 'add_messages' } },
    grants: { data: [], knowledge: [], tools: ['retrieve'], connections: [] },
    routing: { overrides: {} },
    agents: [
      { id: 'supervisor', role: 'routes the work', agent_md: '# supervisor', memory_md: '', members: [] },
    ],
    edges: [],
  };
  const rec = createSystem(user, { name: 'Gate B', domain: 'sales', yaml: serializeSystem(seed) });

  // Helper edit — identical code path to the /assistant route: applyInstruction
  // then commit through the SAME store.writeFile.
  const before = getSystem(rec.id, user).system;
  const { system: edited, summary } = applyInstruction(before, 'add a research sub-agent');
  commit(rec.id, withConnections(edited));
  assert.match(summary, /research/);

  const view = getSystem(rec.id, user).system;
  assert.equal(view.agents.length, 2, 'helper added the sub-agent to the one source');
  const sup = view.agents.find((a) => a.id === 'supervisor')!;
  assert.ok((sup.members ?? []).length === 1, 'sub-agent attached under the supervisor');
  // Narrow-only: the synthesised sub-agent never broadens the system grants.
  const sub = view.agents.find((a) => a.id !== 'supervisor')!;
  for (const t of sub.tools ?? []) assert.ok(view.grants.tools.includes(t));

  await assertBuildsAndVerifies(rec.id);
});

test('routing hits Ministral (light) and local Magistral (reasoning default)', () => {
  const backends = newMockBackends();
  const light = routeProbe('coding', backends.litellm.routing);
  const reasoning = routeProbe('planning', backends.litellm.routing);
  assert.equal(light.tier, 'light');
  assert.match(light.model, /ministral/i);
  assert.equal(reasoning.tier, 'reasoning');
  // Reasoning now defaults to the local sovereign model (Magistral); STACKIT Qwen is the fast option + fallback.
  assert.match(reasoning.model, /sovereign-reasoning/i);
});

test('granted connection works while a non-granted one is blocked; a write is held for approval', async () => {
  __resetStore();
  const rec = createSystem(user, { name: 'Grants', domain: 'sales' });
  commit(rec.id, withConnections(getSystem(rec.id, user).system));

  const sys = getSystem(rec.id, user).system;
  const backends = newMockBackends();
  registerGrants(backends, sys);
  const gw = gatewayFor(backends);

  assert.equal((await gw.authorize('p', 'retrieve')).effect, 'allow', 'granted tool resolves');
  assert.equal((await gw.authorize('p', 'connection_crm')).effect, 'allow', 'granted Read connection resolves');
  assert.equal((await gw.authorize('p', 'connection_crm_write', { write: true })).effect, 'requires_approval', 'a write is held for approval');
  assert.equal((await gw.authorize('p', 'connection_ghost', { write: true })).effect, 'deny', 'a non-granted connection is blocked');
});

test('run / schedule / toggle work at the system level', () => {
  __resetStore();
  const rec = createSystem(user, { name: 'Ops', domain: 'sales' });
  let sys = getSystem(rec.id, user).system;
  sys = addAgent(sys, { id: 'researcher', role: 'finds facts' });
  sys = addSuperviseEdge(sys, sys.entrypoint, 'researcher');
  commit(rec.id, sys);

  assert.equal(setRunning(rec.id, user, true).running, true);
  const scheduled = setSchedule(rec.id, user, { kind: 'cron', cron: '0 9 * * 1' });
  assert.equal(scheduled.schedule.kind, 'cron');
  const toggled = toggleAgent(rec.id, user, 'researcher', false);
  assert.deepEqual(toggled.disabledAgents, ['researcher']);
  const reenabled = toggleAgent(rec.id, user, 'researcher', true);
  assert.deepEqual(reenabled.disabledAgents, []);
  assert.equal(setRunning(rec.id, user, false).running, false);
});
