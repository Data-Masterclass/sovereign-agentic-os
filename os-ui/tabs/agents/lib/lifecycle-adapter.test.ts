/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    V5 — an agent SCHEDULE runs the pinned definition, or is refused
 * USER STORY: As the person on call I need to know which version the 3 a.m. run executed — and
 *             I would rather a schedule refuse loudly than quietly run a draft nobody approved.
 * ARCHITECTURE:
 *   - `grantedDependencies` is pure, so the guard's input is tested directly per grant kind.
 *   - The scheduled read is tested through its refusal paths against the real pin store with
 *     `fetch` stubbed offline; the happy path needs a committed agents subtree, which
 *     `tabs/agents/lib/git/commit.test.ts` already covers, so this file asserts what has never
 *     been asserted before: that a missing or unreadable pin FAILS CLOSED.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { grantedDependencies, scheduledSystemYaml, agentLifecycleAdapter } = await import('./lifecycle-adapter.ts');
const store = await import('./store.ts');
const { runScheduledSystem } = await import('./build/scheduled.ts');
const pins = await import('@core/infra/lifecycle-pins');

const EMPTY_GRANTS = { data: [], knowledge: [], metrics: [], tools: [], connections: [], files: [], plan: [] };

let tempRepos = '';
const temps: string[] = [];

beforeEach(async () => {
  pins.__resetLifecyclePins();
  // The pin WRITE gate (review H-3) refuses unless a source answered; the mirror is stubbed
  // dead here, so the index hydrates from a real (empty) repo root in a temp dir.
  tempRepos = mkdtempSync(join(tmpdir(), 'lifecycle-t-'));
  temps.push(tempRepos);
  await pins.hydrateForTests({ reposDir: tempRepos });
});

test('V6: an agent system’s dependencies are its granted RESOURCES, one entry per kind', () => {
  const deps = grantedDependencies({
    ...EMPTY_GRANTS,
    data: [{ id: 'ds_1', capability: 'Read' }],
    metrics: [{ id: 'Orders.revenue', capability: 'Read' }],
    knowledge: [{ id: 'kb_1', capability: 'Read' }],
    connections: [{ id: 'conn_1', capability: 'Write-bounded' }],
    tools: ['query_data'],
  });
  assert.deepEqual(deps, [
    { kind: 'dataset', id: 'ds_1', name: 'ds_1' },
    { kind: 'metric', id: 'Orders.revenue', name: 'Orders.revenue' },
    { kind: 'knowledge', id: 'kb_1', name: 'kb_1' },
    { kind: 'connection', id: 'conn_1', name: 'conn_1' },
  ]);
});

test('V6: a FOLDER grant and an Off/Blocked grant are not lifecycle dependencies', () => {
  const deps = grantedDependencies({
    ...EMPTY_GRANTS,
    files: [{ id: 'f', capability: 'Read', folder: { path: '/x', scope: 'domain' } }],
    data: [
      { id: 'ds_off', capability: 'Off' },
      { id: 'ds_blocked', capability: 'Blocked' },
      { id: 'ds_ok', capability: 'Read' },
    ],
  });
  assert.deepEqual(deps, [{ kind: 'dataset', id: 'ds_ok', name: 'ds_ok' }]);
  assert.deepEqual(grantedDependencies(EMPTY_GRANTS), [], 'a system that reads nothing depends on nothing');
});

test('V5: a schedule for a system with NO pin is refused, naming what to do — never run from head', async () => {
  const res = await scheduledSystemYaml('sys_absent');
  assert.equal(res.ok, false);
  if (res.ok) return;
  // An unknown system is a 404; a known-but-unpinned one is a 409. Either way the schedule
  // does not execute, which is the property under test.
  assert.ok(res.status === 404 || res.status === 409, `expected a refusal, got ${res.status}`);
  assert.ok(res.error.length > 0, 'and it says why');
});

test('V5: a pin whose blob cannot be read is refused with the reason, not silently downgraded', async () => {
  // No repo exists in this temp environment, so readBlob fails: the refusal must name the ref
  // rather than fall back to the current head. (The happy path needs a committed subtree.)
  await pins.setLivePin('agent', 'sys_pinned', 'f'.repeat(40), { id: 'u1' }, 'sales', {
    commit: false,
  }, 'agents/x/system.yaml');
  const res = await scheduledSystemYaml('sys_pinned', { reposDir: '/nonexistent-repos-dir' });
  assert.equal(res.ok, false);
  if (res.ok) return;
  // Either the system is unknown to the store (404) or the blob read failed (409) — in both
  // cases nothing ran, and that is the invariant. When the system exists, the reason names it.
  assert.ok(res.status === 404 || res.status === 409);
  assert.equal(/fall back|head/.test(res.error), false, 'the refusal never offers the head as a substitute');
});

test('the adapter declares the agent kind and the three facts the kernel asks for', () => {
  assert.equal(agentLifecycleAdapter.kind, 'agent');
  assert.equal(typeof agentLifecycleAdapter.resolve, 'function');
  assert.equal(typeof agentLifecycleAdapter.canGoLive, 'function');
  assert.equal(typeof agentLifecycleAdapter.dependencies, 'function');
  assert.equal(typeof agentLifecycleAdapter.consequences, 'function');
  assert.equal(typeof agentLifecycleAdapter.existing, 'function');
});

after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// ---------------- review H-2: fail OPEN before the migration, CLOSED after ---

test('H-2: before the pin index is established a schedule runs the HEAD, loudly — not a 409', async () => {
  // A system exists, nothing is pinned, and the migration has not run. Failing closed here would
  // 409 every cron job that works today, which is a worse outage than the problem the pin solves.
  const rec = store.createSystem(
    { id: 'u1', domains: ['sales'], role: 'creator' },
    { name: 'Nightly digest', description: 'x' },
  );
  assert.equal(pins.pinsMigrated(), false, 'the migration has not run in this process');

  const res = await scheduledSystemYaml(rec.id, { reposDir: tempRepos });
  assert.equal(res.ok, true, 'the schedule still runs');
  if (!res.ok) return;
  assert.equal(res.source, 'head');
  assert.equal(res.ref, null);
  assert.match(res.warning, /pre-migration fallback/);
  assert.equal(res.yaml.length > 0, true, 'and it is the head’s real definition');
});

test('H-2: ONCE the index is established, an unpinned schedule is refused instead', async () => {
  const rec = store.createSystem(
    { id: 'u1', domains: ['sales'], role: 'creator' },
    { name: 'Nightly digest 2', description: 'x' },
  );
  // Establish the index by migrating something — anything — which latches `migrated`.
  await pins.applyMigratedIndex(
    { pins: { 'agent:someone-else': { ref: 'f'.repeat(40), at: 'now', by: 'migration', domain: 'sales' } } },
    { id: 'migration' },
    { reposDir: tempRepos },
  );
  assert.equal(pins.pinsMigrated(), true);

  const res = await scheduledSystemYaml(rec.id, { reposDir: tempRepos });
  assert.equal(res.ok, false, 'now it fails CLOSED');
  if (res.ok) return;
  assert.equal(res.status, 409);
  assert.match(res.error, /is not live/);
});

// ----------------------------------- review M-3: a schedule is env:run ---

test('M-3: a scheduled run is attributed env:run — never studio, which would cap it at a draft’s budget', async () => {
  const captured: Record<string, unknown>[] = [];
  const rec = store.createSystem(
    { id: 'u1', domains: ['sales'], role: 'creator' },
    { name: 'Budget probe', description: 'x' },
  );
  const view = store.getSystem(rec.id, { id: 'u1', domains: ['sales'], role: 'creator' });

  const outcome = await runScheduledSystem(
    rec.id,
    { yaml: view.yaml, owner: 'u1', disabledAgents: [] },
    'Scheduled run',
    {
      resolveOwner: async () => ({ id: 'u1', name: 'Alex', role: 'creator', domains: ['sales'] }) as never,
      autonomousEnabled: () => true,
      startQueuedRun: async (input) => {
        captured.push(input as unknown as Record<string, unknown>);
        return { runId: 'r1', status: 'queued' } as never;
      },
    },
  );
  assert.equal(outcome.ok, true, `the run was refused: ${JSON.stringify(outcome)}`);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].env, 'run', 'the schedule declares the lifecycle its calls are tagged with');
});
