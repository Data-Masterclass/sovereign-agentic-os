/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    go_live / retire / the pin — V3, V5, V6, V7 and V12's readable half
 * USER STORY: As a reviewer I want the two verbs driven end to end against a REAL bare repo in a
 *             temp dir, so "the pin is recorded, readable in a clone and honoured by what
 *             operates" is a measurement rather than a claim.
 * ARCHITECTURE:
 *   - A fake adapter stands in for a tab, which is the whole point of the registry: the kernel's
 *     go-live path is provable without importing a single tab.
 *   - `fetch` is stubbed to fail before the pin store loads, so the OpenSearch mirror is offline
 *     and the in-process index is authoritative — the laptop/kind path.
 *   - The git half runs against a temp `reposDir`; the committed YAML is read back with
 *     git-store's own `readBlob`, so the assertion is on the BYTES in the repo.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const {
  goLive,
  retire,
  previewGoLive,
  previewRetire,
  lifecycleStatus,
  goLiveDependencies,
} = await import('./go-live.ts');
const { registerLifecycleAdapter, __clearLifecycleAdapters } = await import('./lifecycle-adapters.ts');
const { lifecycleWordOf, lifecycleOf } = await import('./object-lifecycle.ts');
const pins = await import('@core/infra/lifecycle-pins');
const { readBlob, listTree, __clearReservedSubtrees } = await import('@core/infra/git-store');

const ACTOR = { id: 'u1', name: 'Alex', email: 'alex@example.com', role: 'creator', domains: ['sales'] };
const OTHER = { id: 'u2', name: 'Bo', email: 'bo@example.com', role: 'creator', domains: ['sales'] };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let repos: string;
const temps: string[] = [];

/** A tab, faked: three facts about one object plus an owner gate. */
function fakeAdapter(opts: {
  kind: 'dashboard' | 'agent' | 'metric';
  head?: string;
  deps?: { kind: 'metric' | 'dataset'; id: string; name: string }[];
  consequences?: string[];
  tier?: string;
}) {
  const stateRef = { head: opts.head ?? SHA_A };
  registerLifecycleAdapter({
    kind: opts.kind,
    resolve: async (_actor, id) => {
      if (id !== 'obj_1') {
        const e = new Error(`no ${opts.kind} '${id}'`) as Error & { status: number };
        e.status = 404;
        throw e;
      }
      return {
        kind: opts.kind,
        id,
        name: 'Revenue by region',
        domain: 'sales',
        head: stateRef.head,
        tier: opts.tier ?? 'personal',
      };
    },
    canGoLive: async (actor) =>
      actor.id === ACTOR.id
        ? { ok: true as const }
        : { ok: false as const, reason: `only the owner may change what runs for ${opts.kind} 'obj_1'` },
    dependencies: async () => opts.deps ?? [],
    consequences: async () => opts.consequences ?? [],
  });
  return stateRef;
}

/**
 * Review H-1: a dependency whose KIND has no adapter is now treated as satisfied-with-a-warning,
 * because otherwise an object is refused forever for something nobody can pin. So a test that
 * wants the GUARD to bite must register the dependency's kind too.
 */
function registerPinOnly(kind: 'metric' | 'dataset' | 'knowledge' | 'connection') {
  registerLifecycleAdapter({
    kind,
    resolve: async (_a, id) => ({ kind, id, name: id, domain: 'sales', head: SHA_B, tier: 'personal' }),
    canGoLive: async () => ({ ok: true }),
  });
}

beforeEach(async () => {
  __clearLifecycleAdapters();
  __clearReservedSubtrees();
  pins.__resetLifecyclePins();
  repos = mkdtempSync(join(tmpdir(), 'lifecycle-pins-'));
  temps.push(repos);

  // The pin WRITE gate (review H-3) refuses unless a source answered; the mirror is stubbed
  // dead here, so the index hydrates from a real (empty) repo root in a temp dir.
  await pins.hydrateForTests({ reposDir: repos });
});

after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// ----------------------------------------------------------------- V3: the verbs ---

test('V3: go_live pins the head, records it in os/lifecycle/pins.yml and names the tag', async () => {
  fakeAdapter({ kind: 'dashboard', consequences: ['everyone in Run sees this version'] });
  const res = await goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos, surface: 'mcp:go_live' });

  assert.equal(res.live, SHA_A, 'the head is what gets pinned when no sha is named');
  assert.equal(lifecycleWordOf(res.lifecycle), 'live');
  assert.equal(res.tag.name, 'live/dashboard/obj_1');
  assert.equal(res.tag.written, false, 'honest: the git tag needs S’s annotatedTag (deviation V-3)');
  assert.ok(res.commit && res.commit.changed, 'the pin was committed');
  assert.deepEqual(res.starts, ['everyone in Run sees this version']);

  const yml = await readBlob('sales', undefined, pins.LIFECYCLE_PIN_PATH, { reposDir: repos });
  assert.match(yml, /kind: dashboard/);
  assert.match(yml, /id: obj_1/);
  assert.match(yml, new RegExp(`ref: ${SHA_A}`));
  assert.match(yml, /tag: live\/dashboard\/obj_1/);
  assert.match(yml, /NOT pushable/, 'the file says it is OS-owned and not pushable');
});

test('V3: go_live pins a NAMED sha when the caller gives one', async () => {
  fakeAdapter({ kind: 'agent' });
  const res = await goLive(ACTOR, 'agent', 'obj_1', SHA_B, { reposDir: repos });
  assert.equal(res.live, SHA_B);
  assert.equal((await pins.livePin('agent', 'obj_1'))?.ref, SHA_B);
});

test('V3: retire unpins and deletes NOTHING', async () => {
  fakeAdapter({ kind: 'dashboard' });
  await goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos });
  const res = await retire(ACTOR, 'dashboard', 'obj_1', { reposDir: repos });

  assert.equal(res.unpinned, true);
  assert.deepEqual(res.deleted, [], 'nothing is deleted');
  assert.equal(lifecycleWordOf(res.lifecycle), 'draft', 'back to a Draft — still editable');
  assert.equal(await pins.livePin('dashboard', 'obj_1'), undefined);

  // The object itself is untouched: it still resolves, at the same head.
  const after = await lifecycleStatus(ACTOR, 'dashboard', 'obj_1');
  assert.equal(after.object.head, SHA_A);
  assert.equal(after.word, 'draft');

  // And the pin file now records nothing live, rather than having been deleted.
  const yml = await readBlob('sales', undefined, pins.LIFECYCLE_PIN_PATH, { reposDir: repos });
  assert.match(yml, /live: \[\]/);
});

test('V3: retiring something that was never live is a no-op, not an error', async () => {
  fakeAdapter({ kind: 'dashboard' });
  const res = await retire(ACTOR, 'dashboard', 'obj_1', { reposDir: repos });
  assert.equal(res.unpinned, false);
});

test('V3: the pin file lives in its OWN subtree, so it cannot collide with the dbt project’s os/ files', async () => {
  fakeAdapter({ kind: 'dashboard' });
  await goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos });
  const tree = await listTree('sales', undefined, { reposDir: repos });
  assert.deepEqual(
    tree.map((e) => e.path),
    [pins.LIFECYCLE_PIN_PATH],
  );
  assert.equal(pins.LIFECYCLE_PREFIX, 'os/lifecycle');
});

// -------------------------------------------------------- V6: the go-live guard ---

test('V6: go_live is REFUSED, naming the dependency, when a dependency is not live', async () => {
  fakeAdapter({ kind: 'dashboard', deps: [{ kind: 'metric', id: 'sales.revenue', name: 'Revenue' }] });
  registerPinOnly('metric');

  await assert.rejects(
    () => goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 409, 'a draft dependency is a conflict, not a bad request');
      assert.match(e.message, /Revenue/, 'the refusal must NAME the offending dependency');
      assert.match(e.message, /not Live/);
      return true;
    },
  );
  assert.equal(await pins.livePin('dashboard', 'obj_1'), undefined, 'and nothing was pinned');
});

test('V6: once the dependency is live, the same go_live succeeds', async () => {
  fakeAdapter({ kind: 'dashboard', deps: [{ kind: 'metric', id: 'sales.revenue', name: 'Revenue' }] });
  registerPinOnly('metric');
  await pins.setLivePin('metric', 'sales.revenue', SHA_B, ACTOR, 'sales', { commit: false });
  const res = await goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos });
  assert.equal(res.live, SHA_A);
});

test('V6: the dependency list carries each dependency’s OWN lifecycle, never an audience', async () => {
  fakeAdapter({
    kind: 'dashboard',
    tier: 'marketplace',
    deps: [{ kind: 'dataset', id: 'ds_1', name: 'Orders' }],
  });
  registerPinOnly('dataset');
  await pins.setLivePin('dataset', 'ds_1', SHA_B, ACTOR, 'sales', { commit: false });
  const status = await lifecycleStatus(ACTOR, 'dashboard', 'obj_1');
  const { dependencies: deps, warnings } = await goLiveDependencies(ACTOR, status.object);
  assert.deepEqual(warnings, [], 'every dependency kind was wired, so nothing was assumed');
  assert.equal(deps.length, 1);
  assert.equal(lifecycleWordOf(deps[0].lifecycle), 'live');
  assert.equal('tier' in deps[0], false, 'a dependency carries no audience at all');
  // A Company dashboard on a live dependency: the guard allows it, exactly as for a My one.
  const res = await goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos });
  assert.equal(res.live, SHA_A);
});

// ------------------------------------------------------- V7 / honest refusals ---

test('V7: an unknown kind is a bad_request-shaped 400 that lists the kinds', async () => {
  await assert.rejects(
    () => goLive(ACTOR, 'workflow', 'obj_1'),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /not a lifecycle kind/);
      return true;
    },
  );
});

test('V7: a kind nobody has wired up is a 404 that says so — never a silent success', async () => {
  await assert.rejects(
    () => goLive(ACTOR, 'app', 'obj_1'),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 404);
      assert.match(e.message, /not wired up for app yet/);
      return true;
    },
  );
});

test('V7: an object that does not exist is the adapter’s own 404', async () => {
  fakeAdapter({ kind: 'dashboard' });
  await assert.rejects(
    () => goLive(ACTOR, 'dashboard', 'nope'),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 404);
      return true;
    },
  );
});

test('V7: a user who may not operate the object gets a 403 naming why, and nothing is pinned', async () => {
  fakeAdapter({ kind: 'dashboard' });
  await assert.rejects(
    () => goLive(OTHER, 'dashboard', 'obj_1', undefined, { reposDir: repos }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 403);
      assert.match(e.message, /only the owner/);
      return true;
    },
  );
  assert.equal(await pins.livePin('dashboard', 'obj_1'), undefined);
});

test('V7: an object with nothing saved yet cannot go live — a 409 that says what to do', async () => {
  fakeAdapter({ kind: 'dashboard', head: '' });
  await assert.rejects(
    () => goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /save it once/);
      return true;
    },
  );
});

// ------------------------------------------------- the ONE confirm dialog ---

test('V8: previewGoLive has no side effect and states what starts running', async () => {
  fakeAdapter({
    kind: 'agent',
    consequences: ['its cron schedule runs the pinned system.yaml'],
  });
  const p = await previewGoLive(ACTOR, 'agent', 'obj_1');
  assert.equal(p.ref, SHA_A);
  assert.equal(p.blocked, null);
  assert.ok(p.confirm.body.includes('cron schedule runs the pinned system.yaml'));
  assert.equal(p.confirm.confirmLabel, 'Go live');
  assert.equal(await pins.livePin('agent', 'obj_1'), undefined, 'a preview pins nothing');
});

test('V8: previewGoLive reports the block BEFORE the user commits, naming the dependency', async () => {
  fakeAdapter({ kind: 'dashboard', deps: [{ kind: 'metric', id: 'm1', name: 'Revenue' }] });
  registerPinOnly('metric');
  const p = await previewGoLive(ACTOR, 'dashboard', 'obj_1');
  assert.match(String(p.blocked), /Revenue/);
});

test('V8: previewRetire says nothing is deleted', async () => {
  fakeAdapter({ kind: 'dashboard' });
  const p = await previewRetire(ACTOR, 'dashboard', 'obj_1');
  assert.match(p.confirm.body, /Nothing is deleted/);
});

// --------------------------------------------- editing does not move the pin ---

test('V5: editing a live object moves the draft and leaves the pin exactly where it was', async () => {
  const stateRef = fakeAdapter({ kind: 'dashboard' });
  await goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos });
  assert.equal((await pins.livePin('dashboard', 'obj_1'))?.ref, SHA_A);

  stateRef.head = SHA_B; // the user edits and saves

  const after = await lifecycleStatus(ACTOR, 'dashboard', 'obj_1');
  assert.equal(after.lifecycle.draft, SHA_B, 'the draft moved');
  assert.equal(after.lifecycle.live, SHA_A, 'the pin did NOT');
  assert.equal(after.word, 'live');

  await goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos });
  assert.equal((await pins.livePin('dashboard', 'obj_1'))?.ref, SHA_B, 'going live again moves it');
});

// --------------------------------------------------- V10: the migration ---

test('V10: the migration pins every existing object and the pin file records them all', async () => {
  const index = { pins: {} as Record<string, never>, tests: {} };
  const { migrateExistingToLive } = await import('./object-lifecycle.ts');
  const migrated = migrateExistingToLive(
    [
      { kind: 'dashboard', id: 'd1', head: SHA_A, domain: 'sales' },
      { kind: 'agent', id: 's1', head: SHA_B, domain: 'sales' },
    ],
    new Date().toISOString(),
    'migration',
    index as never,
  );
  const res = await pins.applyMigratedIndex(migrated, ACTOR, { reposDir: repos });
  assert.equal(res.pinned, 2);
  assert.deepEqual(res.domains, ['sales']);

  const live = await pins.lifecycleIndex();
  assert.equal(lifecycleWordOf(lifecycleOf('dashboard', 'd1', SHA_A, live)), 'live');
  assert.equal(lifecycleWordOf(lifecycleOf('agent', 's1', SHA_B, live)), 'live');
  assert.equal(
    lifecycleWordOf(lifecycleOf('dashboard', 'brand_new', SHA_A, live)),
    'draft',
    'a new object is NOT swept into Live by the migration',
  );

  const yml = await readBlob('sales', undefined, pins.LIFECYCLE_PIN_PATH, { reposDir: repos });
  assert.match(yml, /id: d1/);
  assert.match(yml, /id: s1/);
});

// ----------------------------------------- Testing is not a managed state ---

test('Testing is a marker, not a state: it is set, read and cleared, and nothing is committed', async () => {
  fakeAdapter({ kind: 'metric' });
  await pins.markTesting('metric', 'obj_1', SHA_B);
  const status = await lifecycleStatus(ACTOR, 'metric', 'obj_1');
  assert.equal(status.word, 'testing');
  assert.equal(status.lifecycle.testing, SHA_B);

  await pins.clearTesting('metric', 'obj_1');
  assert.equal((await lifecycleStatus(ACTOR, 'metric', 'obj_1')).word, 'draft');

  // No repo was ever created for a test marker.
  assert.rejects(() => readBlob('sales', undefined, pins.LIFECYCLE_PIN_PATH, { reposDir: repos }));
});

test('H-1: a dependency kind with NO adapter is satisfied with a WARNING, never a dead end', async () => {
  fakeAdapter({ kind: 'dashboard', deps: [{ kind: 'metric', id: 'm_unwired', name: 'Revenue' }] });
  // deliberately no metric adapter
  const p = await previewGoLive(ACTOR, 'dashboard', 'obj_1');
  assert.equal(p.blocked, null, 'not blocked — a refusal nobody can clear is worse than a stated unknown');
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /metric “Revenue” cannot hold a pin yet/);
  const res = await goLive(ACTOR, 'dashboard', 'obj_1', undefined, { reposDir: repos });
  assert.equal(res.warnings.length, 1, 'and the result repeats the unknown rather than hiding it');
});
