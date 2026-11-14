/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Review H-2 — the migration runs ONCE, and never on an unread index
 * USER STORY: As an existing user I want the deploy day to look like the day before: every
 *             dashboard, every schedule, unchanged. And as an operator I want the migration to
 *             do nothing at all rather than guess when it cannot read the index.
 * ARCHITECTURE:
 *   - Fake adapters stand in for the tabs, which is the point of the registry: the whole
 *     migration is provable without importing a single tab.
 *   - `fetch` is stubbed dead, so the index hydrates through the git fallback against a temp
 *     reposDir — the same path a cluster with an unreachable mirror takes.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { migrateEverythingLive } = await import('./lifecycle-migrate.ts');
const { registerLifecycleAdapter, __clearLifecycleAdapters } = await import('./lifecycle-adapters.ts');
const { lifecycleOf, lifecycleWordOf, visibleOnSurface } = await import('./object-lifecycle.ts');
const pins = await import('@core/infra/lifecycle-pins');
const { __clearReservedSubtrees } = await import('@core/infra/git-store');

const SHA = 'a'.repeat(40);
let repos: string;
const temps: string[] = [];

function fake(kind: 'dashboard' | 'agent' | 'metric', rows: { id: string; head: string; domain: string }[]) {
  registerLifecycleAdapter({
    kind,
    resolve: async (_a, id) => ({ kind, id, name: id, domain: 'sales', head: SHA, tier: 'personal' }),
    canGoLive: async () => ({ ok: true }),
    existing: async () => rows,
  });
}

beforeEach(() => {
  __clearLifecycleAdapters();
  __clearReservedSubtrees();
  pins.__resetLifecyclePins();
  repos = mkdtempSync(join(tmpdir(), 'lifecycle-h2-'));
  temps.push(repos);
});
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

test('H-2: the migration pins every existing object of every registered kind', async () => {
  fake('dashboard', [{ id: 'd1', head: 'spec:aaa', domain: 'sales' }]);
  fake('agent', [{ id: 's1', head: SHA, domain: 'sales' }, { id: 's2', head: SHA, domain: 'ops' }]);
  await pins.hydrateForTests({ reposDir: repos });

  const out = await migrateEverythingLive({ id: 'migration' }, { reposDir: repos });
  assert.equal(out.ran, true);
  if (!out.ran) return;
  assert.equal(out.pinned, 3);
  assert.deepEqual(out.domains, ['ops', 'sales']);
  assert.deepEqual(out.perKind, { agent: 2, dashboard: 1 });

  const index = await pins.lifecycleIndex();
  for (const [kind, id] of [['dashboard', 'd1'], ['agent', 's1'], ['agent', 's2']] as const) {
    const l = lifecycleOf(kind, id, SHA, index);
    assert.equal(lifecycleWordOf(l), 'live', `${kind}:${id} must be Live`);
    assert.equal(visibleOnSurface(l, 'run'), true, `${kind}:${id} must still be visible in Run`);
  }
});

test('H-2: it runs ONCE — a second call is a no-op, so a restart cannot resurrect a retirement', async () => {
  fake('dashboard', [{ id: 'd1', head: 'spec:aaa', domain: 'sales' }]);
  await pins.hydrateForTests({ reposDir: repos });
  const first = await migrateEverythingLive({ id: 'migration' }, { reposDir: repos });
  assert.equal(first.ran, true);
  assert.equal(pins.pinsMigrated(), true, 'the latch is set');

  // The user retires it …
  await pins.clearLivePin('dashboard', 'd1', { id: 'u1' }, 'sales', { reposDir: repos });
  // … and the pod restarts.
  const second = await migrateEverythingLive({ id: 'migration' }, { reposDir: repos });
  assert.deepEqual(second, { ran: false, reason: 'already-migrated' });
  assert.equal(await pins.livePin('dashboard', 'd1'), undefined, 'the retirement stands');
});

test('H-2: an UNREAD index means the migration does NOTHING and retries on the next boot', async () => {
  fake('dashboard', [{ id: 'd1', head: 'spec:aaa', domain: 'sales' }]);
  // Mirror dead AND no repo root: "we could not find out".
  await pins.hydrateForTests({ reposDir: '/dev/null/not-a-directory' });
  assert.equal(pins.pinsHydrationState(), 'offline');

  const out = await migrateEverythingLive({ id: 'migration' }, { reposDir: repos });
  assert.deepEqual(out, { ran: false, reason: 'not-hydrated' });
  assert.equal(pins.pinsMigrated(), false, 'the latch is NOT set, so the next boot tries again');
  assert.deepEqual((await pins.lifecycleIndex()).pins, {}, 'and nothing was written');
});

test('H-2: with no adapters registered it does nothing, rather than pinning an empty world', async () => {
  await pins.hydrateForTests({ reposDir: repos });
  assert.deepEqual(await migrateEverythingLive({ id: 'migration' }, { reposDir: repos }), {
    ran: false,
    reason: 'no-adapters',
  });
});

test('H-2: a row with no domain is REPORTED, not pinned into nowhere (review M-1)', async () => {
  fake('dashboard', [
    { id: 'ok', head: 'spec:aaa', domain: 'sales' },
    { id: 'homeless', head: 'spec:bbb', domain: '' },
  ]);
  await pins.hydrateForTests({ reposDir: repos });
  const out = await migrateEverythingLive({ id: 'migration' }, { reposDir: repos });
  assert.equal(out.ran, true);
  if (!out.ran) return;
  assert.equal(out.pinned, 1);
  assert.match(out.skipped.join(' '), /homeless/);
  assert.match(out.skipped.join(' '), /no domain/);
});

test('H-2: a kind whose adapter cannot enumerate is skipped by NAME, never guessed at', async () => {
  registerLifecycleAdapter({
    kind: 'metric',
    resolve: async (_a, id) => ({ kind: 'metric', id, name: id, domain: 'sales', head: SHA, tier: 'personal' }),
    canGoLive: async () => ({ ok: true }),
  });
  fake('dashboard', [{ id: 'd1', head: 'spec:aaa', domain: 'sales' }]);
  await pins.hydrateForTests({ reposDir: repos });
  const out = await migrateEverythingLive({ id: 'migration' }, { reposDir: repos });
  assert.equal(out.ran, true);
  if (!out.ran) return;
  assert.match(out.skipped.join(' '), /metric: its adapter cannot enumerate/);
});

test('H-2: an adapter that THROWS is reported and the other kinds still migrate', async () => {
  registerLifecycleAdapter({
    kind: 'metric',
    resolve: async (_a, id) => ({ kind: 'metric', id, name: id, domain: 'sales', head: SHA, tier: 'personal' }),
    canGoLive: async () => ({ ok: true }),
    existing: async () => {
      throw new Error('the metrics store is unreachable');
    },
  });
  fake('dashboard', [{ id: 'd1', head: 'spec:aaa', domain: 'sales' }]);
  await pins.hydrateForTests({ reposDir: repos });
  const out = await migrateEverythingLive({ id: 'migration' }, { reposDir: repos });
  assert.equal(out.ran, true);
  if (!out.ran) return;
  assert.equal(out.pinned, 1, 'the dashboard still went live');
  assert.match(out.skipped.join(' '), /metrics store is unreachable/);
});
