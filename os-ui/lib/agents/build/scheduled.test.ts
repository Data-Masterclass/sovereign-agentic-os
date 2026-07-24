/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import type { LlmCall } from '@/lib/assistant/agentic';
import { parseSystem, serializeSystem, type System } from '../system-schema.ts';
import { type OsToolDeps } from './os-tools.ts';
import { runOsTeam } from './agentic-graph-server.ts';
import { runScheduledSystem, resolveOwner, type ScheduledDeps } from './scheduled.ts';

/**
 * T5 — a scheduled/unattended run of an agentic-os team acts under the system
 * OWNER's resolved LIVE identity. The owner principal (id/role/domains) is threaded
 * all the way into the governed tool dispatch — never a service principal. An
 * unresolvable owner fails the run cleanly (409) with NO service-identity fallback.
 * A hermes/legacy system still uses the runtime `runSystem` path.
 */

const OWNER: CurrentUser = { id: 'owner1', name: 'Olive Owner', domains: ['finance'], role: 'creator' };

/** A single-agent agentic-os team whose grants span TWO tabs (data + knowledge). */
function mixedYaml(): string {
  const sys: System = parseSystem({
    version: '1',
    system: { name: 'Insights', domain: 'finance', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'analyst',
    grants: { tools: ['query_data', 'search_knowledge'] },
    agents: [{ id: 'analyst', role: 'agent', agent_md: 'You analyse.', memory_md: '' }],
  });
  return serializeSystem(sys);
}

/** A hermes/legacy system — must keep the `runSystem` fallback. */
function hermesYaml(): string {
  const sys: System = parseSystem({
    version: '1',
    system: { name: 'Legacy', domain: 'finance', visibility: 'Personal' },
    runtime: 'hermes',
    entrypoint: 'a',
    grants: { tools: ['query_data'] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  });
  return serializeSystem(sys);
}

/** Plan (no tools) → one `query_data` tool call → finish. One governed dispatch. */
function toolCallingLlm(toolName: string): LlmCall {
  let acts = 0;
  return async (req) => {
    if (!req.tools || req.tools.length === 0) return { content: 'plan: query the data', toolCalls: [] };
    acts += 1;
    if (acts === 1) return { content: '', toolCalls: [{ id: 'c1', name: toolName, args: { sql: 'select 1' } }] };
    return { content: 'done: analysed 1 row', toolCalls: [] };
  };
}

/** Spy deps: handleRpc records the (user, tool) it dispatched. */
function spyDeps(): OsToolDeps & { calls: { handleRpc: { user: CurrentUser; name: string }[] } } {
  const calls = { handleRpc: [] as { user: CurrentUser; name: string }[] };
  const deps: OsToolDeps = {
    enqueue: (() => ({}) as never) as OsToolDeps['enqueue'],
    handleRpc: (async (user, req) => {
      const name = (req.params as { name?: string })?.name ?? '';
      calls.handleRpc.push({ user, name });
      return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"rows":[{"n":1}]}' }] } };
    }) as OsToolDeps['handleRpc'],
    trace: (async () => ({}) as never) as OsToolDeps['trace'],
  };
  return Object.assign(deps, { calls });
}

// --- 1) agentic-os scheduled run dispatches tools as the RESOLVED OWNER --------

test('scheduled agentic-os run: tools dispatch as the resolved OWNER (id/role/domains), never a service principal', async () => {
  const spy = spyDeps();
  let seenUser: CurrentUser | undefined;

  // Real runOsTeam, but injected with the fake LLM + spy governed deps so we can
  // observe the identity that reaches the governed dispatch end-to-end.
  const wiredRunOsTeam: ScheduledDeps['runOsTeam'] = (input) => {
    seenUser = input.user;
    return runOsTeam({ ...input, llm: toolCallingLlm('query_data'), toolDeps: spy, maxIterations: 3 });
  };

  const outcome = await runScheduledSystem(
    'sys-mix',
    { yaml: mixedYaml(), owner: OWNER.id, disabledAgents: [] },
    'Scheduled run',
    { resolveOwner: async (id) => (id === OWNER.id ? OWNER : null), runOsTeam: wiredRunOsTeam },
  );

  assert.equal(outcome.ok, true, 'the run succeeded');
  // The owner was threaded into runOsTeam as `user`.
  assert.equal(seenUser, OWNER);
  // …and all the way into the governed tool dispatch — as the owner, not os-sys-mix.
  assert.equal(spy.calls.handleRpc.length, 1, 'one governed dispatch');
  const call = spy.calls.handleRpc[0];
  assert.equal(call.name, 'query_data');
  assert.equal(call.user, OWNER);
  assert.equal(call.user.id, 'owner1');
  assert.equal(call.user.role, 'creator');
  assert.deepEqual(call.user.domains, ['finance']);
});

// --- 2) unresolvable owner → clean 409, NO service fallback -------------------

test('scheduled agentic-os run: an unresolvable owner fails 409 with NO service-identity fallback', async () => {
  let osTeamCalled = false;
  let systemCalled = false;

  const outcome = await runScheduledSystem(
    'sys-mix',
    { yaml: mixedYaml(), owner: 'deleted-user', disabledAgents: [] },
    'Scheduled run',
    {
      resolveOwner: async () => null, // deleted / disabled / setup-incomplete
      runOsTeam: (() => {
        osTeamCalled = true;
        return Promise.reject(new Error('must not run'));
      }) as ScheduledDeps['runOsTeam'],
      runSystem: (() => {
        systemCalled = true;
        return Promise.reject(new Error('must not fall back to runSystem'));
      }) as ScheduledDeps['runSystem'],
    },
  );

  assert.equal(outcome.ok, false, 'the run was refused');
  assert.equal(outcome.ok === false && outcome.status, 409);
  assert.match(outcome.ok === false ? outcome.error : '', /never fall back to a service principal/);
  // The governed graph never ran, and there was NO downgrade to the runSystem path.
  assert.equal(osTeamCalled, false, 'runOsTeam not invoked without an owner');
  assert.equal(systemCalled, false, 'no service-principal / runSystem fallback');
});

// --- 3) hermes/legacy → keeps the runSystem fallback -------------------------

test('scheduled hermes run: keeps the runSystem fallback (no owner resolution)', async () => {
  let resolved = false;
  let runSystemArgs: unknown;

  const outcome = await runScheduledSystem(
    'sys-hermes',
    { yaml: hermesYaml(), owner: OWNER.id, disabledAgents: ['x'] },
    'Scheduled run',
    {
      resolveOwner: async () => {
        resolved = true;
        return OWNER;
      },
      runSystem: ((systemId, _yaml, opts) => {
        runSystemArgs = { systemId, opts };
        return Promise.resolve({ mode: 'runtime', ok: true } as never);
      }) as ScheduledDeps['runSystem'],
    },
  );

  assert.equal(outcome.ok, true);
  assert.equal(resolved, false, 'hermes never resolves an owner (no per-tool user identity)');
  assert.deepEqual(
    (runSystemArgs as { systemId: string; opts: { requestedBy: string; disabledAgents: string[] } }),
    { systemId: 'sys-hermes', opts: { prompt: 'Scheduled run', requestedBy: 'scheduler', disabledAgents: ['x'] } },
  );
});

// --- 4) resolveOwner: live role/domains, refuses inactive owners -------------

test('resolveOwner: returns a live principal for an active owner, null for disabled / setup-incomplete', async () => {
  const active = { id: 'u1', name: 'A', domains: ['sales'], role: 'builder', disabled: false } as never;
  const disabled = { id: 'u2', name: 'B', domains: ['sales'], role: 'creator', disabled: true } as never;
  const pending = { id: 'u3', name: 'C', domains: ['sales'], role: 'creator', mustChangeCredentials: true } as never;

  const ok = await resolveOwner('u1', async () => active);
  // Headless principals carry the full scope (no active-domain narrowing): allDomains === domains, activeDomain null.
  assert.deepEqual(ok, { id: 'u1', name: 'A', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'builder' });

  assert.equal(await resolveOwner('u2', async () => disabled), null, 'disabled owner → null');
  assert.equal(await resolveOwner('u3', async () => pending), null, 'setup-incomplete owner → null');
  assert.equal(await resolveOwner('gone', async () => null), null, 'missing owner → null');
});

// --- 5) S1: a stale direct-write grant is downgraded to held-for-approval at run --

/** An agentic-os team carrying a direct-write (Write-bounded) connection grant. */
function directWriteYaml(): string {
  const sys: System = parseSystem({
    version: '1',
    system: { name: 'Writer', domain: 'finance', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'analyst',
    grants: {
      tools: ['query_data', 'search_knowledge'],
      data: [{ id: 'fin.ledger', capability: 'Write-bounded' }],
      connections: [{ id: 'erp', capability: 'Write-bounded' }],
    },
    agents: [{ id: 'analyst', role: 'agent', agent_md: 'You analyse.', memory_md: '' }],
  });
  return serializeSystem(sys);
}

test('S1: scheduled run downgrades a stale Write-bounded grant to Write-approval when the owner is no longer builder+', async () => {
  let ranYaml = '';
  const wiredRunOsTeam: ScheduledDeps['runOsTeam'] = (input) => {
    ranYaml = input.yaml; // capture the yaml the governed run actually received
    return Promise.resolve({ path: [], finalText: 'ok', runs: [] } as never);
  };

  // Owner resolves LIVE as a creator (e.g. demoted since the grant was set).
  await runScheduledSystem(
    'sys-writer',
    { yaml: directWriteYaml(), owner: OWNER.id, disabledAgents: [] },
    'Scheduled run',
    { resolveOwner: async () => OWNER, runOsTeam: wiredRunOsTeam },
  );

  const ran = parseSystem(ranYaml);
  assert.equal(ran.grants.data[0].capability, 'Write-approval', 'data direct-write neutralised');
  assert.equal(ran.grants.connections[0].capability, 'Write-approval', 'connection direct-write neutralised');
});

test('S1: a builder owner keeps direct write on a scheduled run', async () => {
  let ranYaml = '';
  const wiredRunOsTeam: ScheduledDeps['runOsTeam'] = (input) => {
    ranYaml = input.yaml;
    return Promise.resolve({ path: [], finalText: 'ok', runs: [] } as never);
  };
  const builderOwner: CurrentUser = { ...OWNER, role: 'builder' };
  await runScheduledSystem(
    'sys-writer',
    { yaml: directWriteYaml(), owner: builderOwner.id, disabledAgents: [] },
    'Scheduled run',
    { resolveOwner: async () => builderOwner, runOsTeam: wiredRunOsTeam },
  );
  const ran = parseSystem(ranYaml);
  assert.equal(ran.grants.data[0].capability, 'Write-bounded', 'builder keeps direct write');
});
