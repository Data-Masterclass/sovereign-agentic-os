/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    V9 (UI half) — the batched lookup behind every tile list and every badge
 * USER STORY: As a user opening a tab with forty tiles I want the badges without forty requests,
 *             and if the lookup fails I want a tile to read as a Draft rather than claim it is
 *             Live — "we could not find out" must never render as the thing the company runs.
 * ARCHITECTURE:
 *   - The fetcher is INJECTED, so the batching, the coalescing and the fail-soft rule are tested
 *     with no React and no network. The React hooks are thin wrappers over exactly these calls.
 *   - One test per MOUNTED list asserts, by reading the `.tsx` as text, that the list goes
 *     through the shared hook and that no list grew a second filter of its own (a test cannot
 *     import a `.tsx`, so this is how the mounts are held in place).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  requestLifecycles,
  lifecycleWordFor,
  lifecycleForTile,
  subscribeLifecycles,
  invalidateLifecycles,
  __setLifecycleLookup,
  type LifecycleLookup,
} from './lifecycle-cache.ts';
import { lifecycleWordOf } from '@core/kernel/object-lifecycle';
import { tilesForSurface } from '@core/prefs/view-surface-pure';

const UI = join(process.cwd(), '..', 'os-ui');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

let calls: { kind: string; ids: string[] }[] = [];

function lookup(answer: Record<string, string>, fail = false): LifecycleLookup {
  return async (kind, ids) => {
    calls.push({ kind, ids: [...ids] });
    if (fail) throw new Error('offline');
    return answer;
  };
}

beforeEach(() => {
  calls = [];
  __setLifecycleLookup(null);
});

// ------------------------------------------------------------- the batching ---

test('V9: every id asked for in one tick becomes ONE request', async () => {
  __setLifecycleLookup(lookup({ a: 'live', b: 'draft', c: 'testing' }));
  requestLifecycles('dashboard', ['a', 'b']);
  requestLifecycles('dashboard', ['b', 'c']); // a second list, same tick
  await tick();
  assert.equal(calls.length, 1, 'one request, not one per list');
  assert.deepEqual(calls[0], { kind: 'dashboard', ids: ['a', 'b', 'c'] }, 'deduped, in ask order');
});

test('V9: an id is never asked for twice, and a second pass needs no request at all', async () => {
  __setLifecycleLookup(lookup({ a: 'live' }));
  requestLifecycles('metric', ['a']);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(requestLifecycles('metric', ['a']), true, 'already known');
  await tick();
  assert.equal(calls.length, 1, 'still one request');
});

test('V9: two kinds are two independent requests — a dashboard id never answers for a metric', async () => {
  __setLifecycleLookup(lookup({ a: 'live' }));
  requestLifecycles('dashboard', ['a']);
  requestLifecycles('metric', ['a']);
  await tick();
  assert.deepEqual(calls.map((c) => c.kind).sort(), ['dashboard', 'metric']);
});

test('V9: the words land, and translate into the Lifecycle the badges render', async () => {
  __setLifecycleLookup(lookup({ a: 'live', b: 'draft', c: 'testing' }));
  requestLifecycles('agent', ['a', 'b', 'c']);
  await tick();
  assert.equal(lifecycleWordFor('agent', 'a'), 'live');
  assert.equal(lifecycleWordFor('agent', 'b'), 'draft');
  assert.equal(lifecycleWordFor('agent', 'c'), 'testing');
  assert.equal(lifecycleWordOf(lifecycleForTile('agent', 'a')), 'live');
  assert.equal(lifecycleWordOf(lifecycleForTile('agent', 'c')), 'testing');
  assert.deepEqual(lifecycleForTile('agent', 'b'), { draft: 'unversioned' }, 'a list carries no draft ref');
});

test('V9: an unanswered id reads as a DRAFT — a failed lookup never renders as Live', async () => {
  __setLifecycleLookup(lookup({}, true));
  requestLifecycles('dataset', ['x']);
  await tick();
  assert.equal(lifecycleWordFor('dataset', 'x'), 'draft');
  assert.equal(lifecycleWordFor('dataset', 'never-asked'), 'draft');
});

test('V9: a junk word from the server is ignored, not rendered', async () => {
  __setLifecycleLookup(lookup({ a: 'PRODUCTION' }));
  requestLifecycles('dataset', ['a']);
  await tick();
  assert.equal(lifecycleWordFor('dataset', 'a'), 'draft');
});

test('V9: subscribers are told once the answer lands, so a mounted badge re-renders', async () => {
  __setLifecycleLookup(lookup({ a: 'live' }));
  let told = 0;
  const off = subscribeLifecycles('dashboard', () => {
    told += 1;
  });
  requestLifecycles('dashboard', ['a']);
  await tick();
  assert.equal(told, 1);
  off();
  invalidateLifecycles('dashboard');
  assert.equal(told, 1, 'and unsubscribing stops the notifications');
});

test('V9: invalidate forgets a kind, so the badges re-read after a go-live', async () => {
  __setLifecycleLookup(lookup({ a: 'live' }));
  requestLifecycles('dashboard', ['a']);
  await tick();
  assert.equal(lifecycleWordFor('dashboard', 'a'), 'live');
  invalidateLifecycles('dashboard');
  assert.equal(lifecycleWordFor('dashboard', 'a'), 'draft', 'forgotten');
  requestLifecycles('dashboard', ['a']);
  await tick();
  assert.equal(calls.length, 2, 'and asked again');
});

test('V9: the filter rule the hook applies is the SHARED one, over cache words', async () => {
  __setLifecycleLookup(lookup({ live1: 'live', draft1: 'draft', test1: 'testing' }));
  requestLifecycles('dashboard', ['live1', 'draft1', 'test1']);
  await tick();
  const items = [{ id: 'live1' }, { id: 'draft1' }, { id: 'test1' }];
  const of = (i: { id: string }) => lifecycleForTile('dashboard', i.id);
  assert.deepEqual(tilesForSurface(items, 'studio', of).map((i) => i.id), ['live1', 'draft1', 'test1']);
  assert.deepEqual(tilesForSurface(items, 'run', of).map((i) => i.id), ['live1']);
});

// --------------------------------------- one test per mounted list ---

/** Each mounted tile list: the file, the kind it declares, and whether it shows the badge. */
const MOUNTS: { file: string; kind: string; badge: boolean; why?: string }[] = [
  { file: 'tabs/data/ui/DatasetTiles.tsx', kind: 'dataset', badge: true },
  { file: 'tabs/metrics/ui/MetricsRegistry.tsx', kind: 'metric', badge: true },
  { file: 'tabs/dashboards/ui/Tiles.tsx', kind: 'dashboard', badge: true },
  { file: 'tabs/agents/ui/SystemsList.tsx', kind: 'agent', badge: true },
  { file: 'tabs/connections/ui/GovernedConnections.tsx', kind: 'connection', badge: true },
  {
    file: 'app/(experimental)/software/page.tsx',
    kind: 'app',
    badge: false,
    why: 'the tile already renders its own Draft / deploy-state badge (deviation V-12)',
  },
  {
    file: 'app/(plan)/workflows/page.tsx',
    kind: 'knowledge',
    badge: false,
    why: 'the tile already renders its own Draft/Live status badge (deviation V-12)',
  },
];

for (const m of MOUNTS) {
  test(`V9: ${m.kind} — its tile list applies the filter through the SHARED hook`, () => {
    const src = read(m.file);
    assert.match(
      src,
      /useLifecycleTiles|useLifecycleFilter/,
      `${m.file}: the list must go through the shared hook`,
    );
    assert.ok(
      src.includes(`'${m.kind}'`) || src.includes(`"${m.kind}"`),
      `${m.file}: it must declare the kind '${m.kind}'`,
    );
    // Nothing may re-implement the rule locally: the words belong to the hook.
    assert.equal(
      /surface === 'run'|=== 'live' \?|lifecycle === 'live'/.test(src),
      false,
      `${m.file}: the Studio|Run rule must live in the hook, not in the list`,
    );
  });

  test(`V9: ${m.kind} — ${m.badge ? 'the tile shows the lifecycle badge' : 'the badge is deliberately not mounted'}`, () => {
    const src = read(m.file);
    const tile = m.kind === 'knowledge' ? read('tabs/knowledge/ui/WorkflowTile.tsx') : src;
    const mounted = /<TileBadges/.test(tile);
    assert.equal(mounted, m.badge, m.why ?? `${m.file}: expected badge mounted = ${m.badge}`);
    if (!m.badge) {
      assert.match(tile + src, /V-12/, 'a deliberate omission must name the deviation that explains it');
    }
    if (m.badge) {
      assert.match(
        tile,
        /audience=\{false\}/,
        `${m.file}: the tile already has a visibility badge, so audience must be off — never two of the same`,
      );
    }
  });
}

test('V9: the mounted lists are the seven tile surfaces, and the UI root resolves', () => {
  assert.equal(MOUNTS.length, 7);
  assert.ok(UI.endsWith('os-ui'));
  const kinds = MOUNTS.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['agent', 'app', 'connection', 'dashboard', 'dataset', 'knowledge', 'metric']);
});
