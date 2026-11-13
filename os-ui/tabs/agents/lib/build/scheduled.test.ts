/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import type { LlmCall } from '@core/runtime/agentic';
import { parseSystem, serializeSystem, type System } from '@tabs/agents/lib/system-schema';
import { readFileSync } from 'node:fs';
import { runScheduledSystem, resolveOwner, type ScheduledDeps } from '@tabs/agents/lib/build/scheduled';

/**
 * T5 — a scheduled/unattended run of an agent system acts under the system OWNER's resolved
 * LIVE identity. The owner principal (id/role/domains) reaches the ONE start door
 * (`startQueuedRun`) as the run's `user`, never a service principal; an unresolvable owner
 * fails the run cleanly (409) with no fallback identity.
 *
 * A5: there is no second path to assert any more. The Python-runtime / mock `runSystem`
 * fallback is deleted, so a system that cannot run says WHY (unmapped grants) instead of
 * being routed somewhere weaker. The owner→handleRpc half of the identity thread is tested
 * where it now lives: `agentic-graph-server.test.ts` (the dispatch), `runner-identity.test.ts`
 * (the live re-read) and `jobs-resume.test.ts` (across a resume).
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

// --- 1) a scheduled run reaches the queue as the RESOLVED OWNER ---------------

test('scheduled run: the resolved OWNER (id/role/domains) is the run\'s user at the one start door', async () => {
  let seen: Parameters<NonNullable<ScheduledDeps['startQueuedRun']>>[0] | undefined;

  const outcome = await runScheduledSystem(
    'sys-mix',
    { yaml: mixedYaml(), owner: OWNER.id, disabledAgents: [] },
    'Scheduled run',
    {
      resolveOwner: async (id) => (id === OWNER.id ? OWNER : null),
      startQueuedRun: async (input) => {
        seen = input;
        return { runId: input.runId, mode: 'inline', body: { reachedEnd: true, path: ['analyst'], finalText: 'done', nodes: [] } as never };
      },
      autonomousEnabled: () => true,
    },
  );

  assert.equal(outcome.ok, true, 'the run succeeded');
  assert.equal(seen?.user, OWNER, 'the owner principal IS the run user');
  assert.equal(seen?.user.id, 'owner1');
  assert.equal(seen?.user.role, 'creator');
  assert.deepEqual(seen?.user.domains, ['finance']);
  assert.equal(seen?.systemId, 'sys-mix');
  assert.equal(seen?.domain, 'finance', 'the job records the system domain the runner must still be in');
  assert.deepEqual(seen?.messages, [{ role: 'user', content: 'Scheduled run' }]);
  assert.ok(seen?.runId, 'a run id (= thread id) is minted before the job is filed');
});

test('scheduled run: a grant with no governed tool behind it is refused 400, naming the tool', async () => {
  let started = false;
  const unmappedYaml = serializeSystem(parseSystem({
    version: '1',
    system: { name: 'Legacy grants', domain: 'finance', visibility: 'Personal' },
    entrypoint: 'a',
    grants: { tools: ['query_data', 'web_fetch'] },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
  }));
  const outcome = await runScheduledSystem(
    'sys-legacy',
    { yaml: unmappedYaml, owner: OWNER.id, disabledAgents: [] },
    'Scheduled run',
    {
      resolveOwner: async () => OWNER,
      startQueuedRun: (() => { started = true; return Promise.reject(new Error('must not start')); }) as ScheduledDeps['startQueuedRun'],
      autonomousEnabled: () => true,
    },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.status, 400);
  assert.match(outcome.ok === false ? outcome.error : '', /web_fetch/, 'the error names the offending grant');
  assert.equal(started, false, 'nothing was filed on the queue');
});

// --- 2) unresolvable owner → clean 409, NO service fallback -------------------

test('scheduled run: an unresolvable owner fails 409 with NO service-identity fallback', async () => {
  let started = false;

  const outcome = await runScheduledSystem(
    'sys-mix',
    { yaml: mixedYaml(), owner: 'deleted-user', disabledAgents: [] },
    'Scheduled run',
    {
      resolveOwner: async () => null, // deleted / disabled / setup-incomplete
      startQueuedRun: (() => {
        started = true;
        return Promise.reject(new Error('must not run'));
      }) as ScheduledDeps['startQueuedRun'],
      autonomousEnabled: () => true,
    },
  );

  assert.equal(outcome.ok, false, 'the run was refused');
  assert.equal(outcome.ok === false && outcome.status, 409);
  assert.match(outcome.ok === false ? outcome.error : '', /never fall back to a service principal/);
  assert.equal(started, false, 'nothing was filed on the queue without an owner');
});

// --- 3) A5: there is no second execution path to fall back to -----------------

test('TRIPWIRE: the scheduled door has exactly ONE execution path — the run queue', () => {
  const src = readFileSync(new URL('./scheduled.ts', import.meta.url), 'utf8');
  for (const gone of ['runSystem', 'runOsTeam', 'selectEngine', 'isAgenticOsTeam', 'hermes']) {
    assert.doesNotMatch(src, new RegExp(gone), `${gone} must not come back as a fallback`);
  }
  assert.match(src, /startQueuedRun/, 'the queue is the only start door');
  // S1 (the stale-direct-write downgrade) is re-asserted by the EXECUTOR as the live runner
  // (`prepareRunYaml` → `governYamlForOwner`), so this door must NOT govern a yaml of its own —
  // two authorities for one rule is how they drift apart.
  assert.doesNotMatch(src, /serializeSystem|downgradeGrantsForRole|governSystemForOwner/, 'the yaml is governed once, by the executor');
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

// --- 6) platform autonomous-agents gate: OFF ⇒ unattended run refused (403) ----

test('autonomous-agents gate OFF: a scheduled run is refused 403 BEFORE owner resolution or execution', async () => {
  let resolved = false;
  let started = false;

  const outcome = await runScheduledSystem(
    'sys-mix',
    { yaml: mixedYaml(), owner: OWNER.id, disabledAgents: [] },
    'Scheduled run',
    {
      autonomousEnabled: () => false, // platform default
      resolveOwner: async () => {
        resolved = true;
        return OWNER;
      },
      startQueuedRun: (() => {
        started = true;
        return Promise.reject(new Error('must not run while autonomy is disabled'));
      }) as ScheduledDeps['startQueuedRun'],
    },
  );

  assert.equal(outcome.ok, false, 'the unattended run was refused');
  assert.equal(outcome.ok === false && outcome.status, 403);
  assert.match(outcome.ok === false ? outcome.error : '', /disabled by platform policy/);
  // Fail-closed BEFORE anything happens: no owner resolution, no execution, no fallback.
  assert.equal(resolved, false, 'gate short-circuits before owner resolution');
  assert.equal(started, false, 'nothing was filed on the queue');
});
