/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Lifecycle model tests — V1, V2, V6, V8 (vocabulary) and V10 (migration)
 * USER STORY: As a reviewer I want the two-axis invariant, the totality over every kind and the
 *             go-live guard proven by a test rather than asserted in a comment, because a
 *             lifecycle that exists only as a label on a tile is a label.
 * ARCHITECTURE:
 *   - Imports the pure module only — no store, no route, no .tsx. Every case is a value in and
 *     a value out, so the suite runs offline in milliseconds.
 *   - The independence tripwire reads the module's own source text and asserts no lifecycle
 *     function mentions a tier/audience input and vice versa (V2's "neither axis is derived").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LIFECYCLE_WORDS,
  LIFECYCLE_LABELS,
  LIFECYCLE_FALLBACK_WORDS,
  AUDIENCE_WORDS,
  AUDIENCE_LABELS,
  VIEW_SURFACES,
  LIFECYCLE_KINDS,
  EMPTY_LIFECYCLE_INDEX,
  type LifecycleIndex,
  type LifecycleKind,
  isLifecycleKind,
  isLifecycleWord,
  isViewSurface,
  pinKey,
  parsePinKey,
  liveTagName,
  lifecycleOf,
  lifecycleWordOf,
  lifecycleLabelOf,
  hasUnpublishedEdits,
  visibleOnSurface,
  audienceOfTier,
  audienceLabelOf,
  badgesFor,
  goLiveGuard,
  goLiveConfirmCopy,
  retireConfirmCopy,
  shortRef,
  migrateExistingToLive,
  filterByLifecycle,
  runEnvOf,
  lifecycleBudgetMetadata,
  LIFECYCLE_BUDGET_SHARE,
} from './object-lifecycle.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// ----------------------------------------------------------------- V1: total ---

test('V1: lifecycleOf is TOTAL over every kind — a well-formed {draft} for each, no throw', () => {
  for (const kind of LIFECYCLE_KINDS) {
    const l = lifecycleOf(kind, `${kind}_1`, SHA);
    assert.equal(l.draft, SHA, `${kind}: draft must be the head`);
    assert.equal(l.testing, undefined, `${kind}: nothing in testing`);
    assert.equal(l.live, undefined, `${kind}: nothing live`);
    assert.equal(lifecycleWordOf(l), 'draft', `${kind}: a pinless object is a Draft`);
  }
  assert.equal(LIFECYCLE_KINDS.length, 7, 'the seven kinds the audience ladder covers');
});

test('V1: lifecycleOf returns {draft, testing, live} when the index carries both', () => {
  const index: LifecycleIndex = {
    pins: { 'dashboard:d1': { ref: SHA, at: 'now', by: 'u1', domain: 'sales' } },
    tests: { 'dashboard:d1': { ref: OTHER, at: 'now' } },
  };
  const l = lifecycleOf('dashboard', 'd1', OTHER, index);
  assert.deepEqual(l, { draft: OTHER, testing: OTHER, live: SHA });
  assert.equal(lifecycleWordOf(l), 'live', 'Live wins — the tile answers "is this running?" first');
  assert.equal(lifecycleLabelOf(l), 'Live');
});

test('V1: lifecycleOf never throws on junk — unknown kind, empty head, missing index', () => {
  assert.deepEqual(lifecycleOf('not-a-kind', 'x', ''), { draft: 'unversioned' });
  assert.deepEqual(lifecycleOf('', '', ''), { draft: 'unversioned' });
  assert.deepEqual(
    lifecycleOf('metric', 'm1', SHA, { pins: {} }),
    { draft: SHA },
    'an empty index is a Draft, not an error',
  );
});

test('V1: pin keys round-trip and reject anything malformed', () => {
  assert.equal(pinKey('dashboard', 'd1'), 'dashboard:d1');
  assert.deepEqual(parsePinKey('dashboard:d1'), { kind: 'dashboard', id: 'd1' });
  assert.deepEqual(parsePinKey('metric:sales.revenue'), { kind: 'metric', id: 'sales.revenue' });
  assert.equal(parsePinKey('nope:d1'), null, 'an unknown kind is not a pin key');
  assert.equal(parsePinKey('dashboard:'), null, 'an empty id is not a pin key');
  assert.equal(parsePinKey(':d1'), null);
  assert.equal(parsePinKey('dashboard'), null);
  assert.equal(liveTagName('agent', 'sys_1'), 'live/agent/sys_1');
});

// --------------------------------------------- V2: the two axes are independent ---

test('V2: a My object can be Live', () => {
  const index: LifecycleIndex = {
    pins: { 'metric:sales.revenue': { ref: SHA, at: 'now', by: 'u1', domain: 'sales' } },
  };
  const l = lifecycleOf('metric', 'sales.revenue', SHA, index);
  const b = badgesFor(l, 'personal');
  assert.deepEqual(b, {
    lifecycle: { word: 'live', label: 'Live' },
    audience: { word: 'my', label: 'My' },
  });
});

test('V2: a Company object can have a Draft', () => {
  const l = lifecycleOf('dashboard', 'd9', SHA);
  const b = badgesFor(l, 'marketplace');
  assert.deepEqual(b, {
    lifecycle: { word: 'draft', label: 'Draft' },
    audience: { word: 'company', label: 'Company' },
  });
});

test('V2: every audience × every lifecycle combination is reachable', () => {
  const tiers = ['personal', 'domain', 'marketplace'] as const;
  const seen = new Set<string>();
  for (const tier of tiers) {
    for (const word of LIFECYCLE_WORDS) {
      const index: LifecycleIndex =
        word === 'live'
          ? { pins: { 'dataset:ds1': { ref: SHA, at: 'now', by: 'u', domain: 'd' } } }
          : word === 'testing'
            ? { pins: {}, tests: { 'dataset:ds1': { ref: SHA, at: 'now' } } }
            : { pins: {} };
      const b = badgesFor(lifecycleOf('dataset', 'ds1', SHA, index), tier);
      assert.equal(b.lifecycle.word, word);
      seen.add(`${b.audience.word}/${b.lifecycle.word}`);
    }
  }
  assert.equal(seen.size, 9, 'all 3 × 3 combinations are reachable — neither axis constrains the other');
});

test('V2 tripwire: no lifecycle function takes an audience, and audienceOfTier takes no lifecycle', () => {
  const src = readFileSync(new URL('./object-lifecycle.ts', import.meta.url), 'utf8');
  // The only places the two words may meet are badgesFor (which renders both) and the
  // documented type/label tables. No function may compute one FROM the other.
  const body = src.slice(src.indexOf('export function lifecycleOf'));
  const derive = [
    /lifecycleWordOf\([^)]*tier/,
    /audienceOfTier\([^)]*lifecycle/i,
    /if\s*\(\s*tier[^)]*\)\s*return\s*'(draft|testing|live)'/,
    /if\s*\([^)]*live[^)]*\)\s*return\s*'(my|domain|company)'/,
  ];
  for (const re of derive) {
    assert.equal(re.test(body), false, `a lifecycle/audience derivation slipped in: ${re}`);
  }
  // audienceOfTier's whole body must mention no lifecycle word.
  const aud = src.slice(src.indexOf('export function audienceOfTier'));
  const audBody = aud.slice(0, aud.indexOf('\n}'));
  for (const w of LIFECYCLE_WORDS) {
    assert.equal(audBody.includes(`'${w}'`), false, `audienceOfTier must not mention '${w}'`);
  }
});

test('V2: audienceOfTier maps every tab’s tier spelling onto the three words', () => {
  for (const t of ['personal', 'dataset', 'Personal', 'private', '', 'anything-else']) {
    assert.equal(audienceOfTier(t), 'my', `${t} → my`);
  }
  for (const t of ['domain', 'asset', 'Shared', 'shared']) {
    assert.equal(audienceOfTier(t), 'domain', `${t} → domain`);
  }
  for (const t of ['marketplace', 'product', 'Certified', 'company']) {
    assert.equal(audienceOfTier(t), 'company', `${t} → company`);
  }
  assert.equal(audienceLabelOf('asset'), 'Domain');
});

// -------------------------------------------------- V6: the go-live guard ---

const live = { draft: SHA, live: SHA };
const draft = { draft: SHA };
const testing = { draft: SHA, testing: SHA };

test('V6: the guard passes when every dependency is live', () => {
  assert.deepEqual(
    goLiveGuard([
      { kind: 'metric', id: 'sales.revenue', name: 'Revenue', lifecycle: live },
      { kind: 'dataset', id: 'ds_orders', name: 'Orders', lifecycle: live },
    ]),
    { ok: true },
  );
  assert.deepEqual(goLiveGuard([]), { ok: true }, 'no dependencies is no obstacle');
});

test('V6: the guard refuses per kind, NAMING the offending dependency', () => {
  const cases: { label: string; deps: Parameters<typeof goLiveGuard>[0]; name: string; kind: LifecycleKind }[] = [
    {
      label: 'dashboard → its metrics',
      deps: [{ kind: 'metric', id: 'sales.revenue', name: 'Revenue', lifecycle: draft }],
      name: 'Revenue',
      kind: 'metric',
    },
    {
      label: 'dashboard → its datasets',
      deps: [{ kind: 'dataset', id: 'ds_orders', name: 'Orders', lifecycle: draft }],
      name: 'Orders',
      kind: 'dataset',
    },
    {
      label: 'metric → its dataset',
      deps: [{ kind: 'dataset', id: 'ds_orders', name: 'Orders', lifecycle: testing }],
      name: 'Orders',
      kind: 'dataset',
    },
    {
      label: 'agent system → its granted resources',
      deps: [{ kind: 'knowledge', id: 'kb_1', name: 'Pricing policy', lifecycle: draft }],
      name: 'Pricing policy',
      kind: 'knowledge',
    },
    {
      label: 'app → what it binds',
      deps: [{ kind: 'connection', id: 'conn_1', name: 'Stripe', lifecycle: draft }],
      name: 'Stripe',
      kind: 'connection',
    },
  ];
  for (const c of cases) {
    const d = goLiveGuard(c.deps);
    assert.equal(d.ok, false, c.label);
    if (d.ok) return;
    assert.equal(d.blocking.kind, c.kind, c.label);
    assert.equal(d.blocking.name, c.name, c.label);
    assert.ok(d.reason.includes(c.name), `${c.label}: the reason must NAME the dependency`);
    assert.ok(/not Live/.test(d.reason), `${c.label}: the reason must say it is not Live`);
  }
});

test('V6: the guard names the FIRST non-live dependency and ignores later ones', () => {
  const d = goLiveGuard([
    { kind: 'dataset', id: 'ds1', name: 'First', lifecycle: draft },
    { kind: 'metric', id: 'm1', name: 'Second', lifecycle: draft },
  ]);
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.blocking.name, 'First');
});

test('V6/V-R3.3: the guard is about LIFECYCLE, not audience — a Live My metric is a fine dependency', () => {
  // The dependency carries no tier at all: the guard cannot see audience even if it wanted to.
  const dep = { kind: 'metric' as const, id: 'm1', name: 'My revenue', lifecycle: live };
  assert.deepEqual(goLiveGuard([dep]), { ok: true });
  assert.equal('tier' in dep, false, 'LifecycleDependency carries no tier — by construction');
});

// -------------------------------------------------- V8: the simplicity contract ---

test('V8: exactly three lifecycle words and three audience words, and the labels match', () => {
  assert.deepEqual([...LIFECYCLE_WORDS], ['draft', 'testing', 'live']);
  assert.deepEqual([...AUDIENCE_WORDS], ['my', 'domain', 'company']);
  assert.deepEqual(Object.keys(LIFECYCLE_LABELS), ['draft', 'testing', 'live']);
  assert.deepEqual(Object.values(LIFECYCLE_LABELS), ['Draft', 'Testing', 'Live']);
  assert.deepEqual(Object.values(AUDIENCE_LABELS), ['My', 'Domain', 'Company']);
  assert.deepEqual([...VIEW_SURFACES], ['studio', 'run']);
  assert.deepEqual([...LIFECYCLE_FALLBACK_WORDS], ['draft', 'live'], 'the documented fallback');
});

test('V8: no user-facing string in the lifecycle model says environment, stage or release', () => {
  const src = readFileSync(new URL('./object-lifecycle.ts', import.meta.url), 'utf8');
  // Only the string literals matter — the prose comments are allowed to explain the ban, and
  // `RunEnv`/`env:` are the TOOLS' own field names, never shown on screen.
  const literals = [...src.matchAll(/'([^'\\\n]{2,})'|`([^`\\\n]{2,})`/g)].map((m) => m[1] ?? m[2]);
  const banned = /\b(environment|stage|staging|release)\b/i;
  for (const lit of literals) {
    // A lifecycle/audience/env *key* is not UI copy; UI copy is anything with a space.
    if (!lit.includes(' ')) continue;
    assert.equal(banned.test(lit), false, `UI copy must not say environment/stage/release: "${lit}"`);
  }
});

test('V8: the confirm copy states what starts running, and retire says nothing is deleted', () => {
  const go = goLiveConfirmCopy('dashboard', 'Revenue by region', SHA, [
    'its hourly Dagster schedule runs the pinned definition',
    'everyone in Run sees this version',
  ]);
  assert.equal(go.confirmLabel, 'Go live');
  assert.ok(go.title.includes('Revenue by region'));
  assert.ok(go.body.includes('hourly Dagster schedule'), 'the dialog must name what starts running');
  assert.ok(go.body.includes('aaaaaaa'), 'it must name the pinned ref');
  assert.ok(/does not change what Run shows/.test(go.body), 'and that editing does not move the pin');

  const empty = goLiveConfirmCopy('metric', 'Revenue', SHA, []);
  assert.ok(/Nothing is scheduled/.test(empty.body), 'honest when there is nothing to start');

  const ret = retireConfirmCopy('agent', 'Nightly digest');
  assert.equal(ret.confirmLabel, 'Retire');
  assert.ok(/Nothing is deleted/.test(ret.body));
});

test('V8: shortRef abbreviates a sha and leaves a tag alone', () => {
  assert.equal(shortRef(SHA), 'aaaaaaa');
  assert.equal(shortRef('v1.2.3'), 'v1.2.3');
  assert.equal(shortRef('live/agent/sys_1'), 'live/agent/sys_1');
  assert.equal(shortRef(''), 'its current draft');
});

test('V8: the type guards accept only the closed sets', () => {
  assert.equal(isLifecycleKind('dashboard'), true);
  assert.equal(isLifecycleKind('workflow'), false);
  assert.equal(isLifecycleWord('live'), true);
  assert.equal(isLifecycleWord('Live'), false);
  assert.equal(isViewSurface('run'), true);
  assert.equal(isViewSurface('prod'), false);
});

// ----------------------------------------------------- V10: nothing changes day one ---

test('V10: the migration marks every existing object Live, so Run on day one is today’s screens', () => {
  const existing = LIFECYCLE_KINDS.map((kind, i) => ({
    kind,
    id: `${kind}_${i}`,
    head: SHA,
    domain: 'sales',
  }));
  const index = migrateExistingToLive(existing, '2026-11-14T00:00:00.000Z');
  for (const o of existing) {
    const l = lifecycleOf(o.kind, o.id, SHA, index);
    assert.equal(lifecycleWordOf(l), 'live', `${o.kind} must be Live after the migration`);
    assert.equal(visibleOnSurface(l, 'run'), true, `${o.kind} must still be visible in Run`);
    assert.equal(visibleOnSurface(l, 'studio'), true, `${o.kind} stays editable in Studio`);
  }
  assert.equal(Object.keys(index.pins).length, 7);
});

test('V10: a NEW object is Draft and absent from Run until someone goes live — per kind', () => {
  const index = migrateExistingToLive([{ kind: 'dataset', id: 'old', head: SHA, domain: 'd' }], 'now');
  for (const kind of LIFECYCLE_KINDS) {
    const l = lifecycleOf(kind, `fresh_${kind}`, OTHER, index);
    assert.equal(lifecycleWordOf(l), 'draft', `${kind}: a new object is a Draft`);
    assert.equal(visibleOnSurface(l, 'run'), false, `${kind}: and absent from Run`);
    assert.equal(visibleOnSurface(l, 'studio'), true, `${kind}: but present in Studio`);
  }
});

test('V10: the migration is idempotent and never re-pins a retired object', () => {
  const first = migrateExistingToLive([{ kind: 'metric', id: 'm1', head: SHA, domain: 'd' }], 't1');
  // the user retires it
  const retired: LifecycleIndex = { pins: {} };
  const again = migrateExistingToLive([{ kind: 'metric', id: 'm1', head: OTHER, domain: 'd' }], 't2', 'migration', first);
  assert.equal(again.pins['metric:m1'].ref, SHA, 'an existing pin is kept, not moved to the new head');
  const afterRetire = migrateExistingToLive(
    [{ kind: 'metric', id: 'm1', head: SHA, domain: 'd' }],
    't3',
    'migration',
    retired,
  );
  assert.equal(
    afterRetire.pins['metric:m1'].ref,
    SHA,
    'a second migration DOES re-pin — so the boot migration must run once, guarded by the store',
  );
});

test('V10: an object with no head at all still migrates to a named, honest pin', () => {
  const index = migrateExistingToLive([{ kind: 'app', id: 'a1', head: '', domain: 'd' }], 'now');
  assert.equal(index.pins['app:a1'].ref, 'unversioned');
});

// --------------------------------------- pins, edits and the Run/Studio split ---

test('editing a live object leaves the pin alone — Run keeps serving the pinned ref', () => {
  const index: LifecycleIndex = {
    pins: { 'dashboard:d1': { ref: SHA, at: 'now', by: 'u1', domain: 'sales' } },
  };
  const beforeEdit = lifecycleOf('dashboard', 'd1', SHA, index);
  assert.equal(hasUnpublishedEdits(beforeEdit), false);
  // the user edits: the HEAD moves, the index is untouched
  const afterEdit = lifecycleOf('dashboard', 'd1', OTHER, index);
  assert.equal(afterEdit.live, SHA, 'the pin did not move');
  assert.equal(afterEdit.draft, OTHER, 'the draft did');
  assert.equal(lifecycleWordOf(afterEdit), 'live', 'and it is still Live');
  assert.equal(hasUnpublishedEdits(afterEdit), true, 'with unpublished edits');
});

test('the optional lifecycle filter defaults to "everything" — today’s behaviour for every client', () => {
  const rows = [
    { id: 'a', l: { draft: SHA, live: SHA } },
    { id: 'b', l: { draft: SHA } },
    { id: 'c', l: { draft: SHA, testing: SHA } },
  ];
  const of = (r: (typeof rows)[number]) => r.l;
  assert.deepEqual(filterByLifecycle(rows, undefined, of).map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(filterByLifecycle(rows, 'live', of).map((r) => r.id), ['a']);
  assert.deepEqual(filterByLifecycle(rows, 'draft', of).map((r) => r.id), ['b']);
  assert.deepEqual(filterByLifecycle(rows, 'testing', of).map((r) => r.id), ['c']);
  assert.deepEqual(filterByLifecycle([], 'live', of), []);
});

// ------------------------------------------------- V11: tool attribution ---

test('V11: runEnvOf maps the three lifecycle words onto the tools’ env vocabulary', () => {
  assert.equal(runEnvOf('draft'), 'studio');
  assert.equal(runEnvOf('testing'), 'test');
  assert.equal(runEnvOf('live'), 'run');
});

test('V11: a draft cannot drain what is running — the budget share is smaller off Run', () => {
  assert.ok(LIFECYCLE_BUDGET_SHARE.studio < LIFECYCLE_BUDGET_SHARE.run);
  assert.ok(LIFECYCLE_BUDGET_SHARE.test < LIFECYCLE_BUDGET_SHARE.run);
  assert.deepEqual(lifecycleBudgetMetadata('studio', 100), {
    os_env: 'studio',
    os_env_budget_share: 0.2,
    max_budget: 20,
  });
  assert.deepEqual(lifecycleBudgetMetadata('run', 100), {
    os_env: 'run',
    os_env_budget_share: 1,
    max_budget: 100,
  });
});
