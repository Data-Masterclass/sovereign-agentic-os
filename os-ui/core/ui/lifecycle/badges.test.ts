/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    V1.3 / V1.4 / V8 — the two badges, the one toggle, the one button's copy
 * USER STORY: As a reviewer I want the screen half of the simplicity contract tested, not just
 *             inspected: two badges, three words each, one toggle with two words, one Go-live
 *             button, and no UI string anywhere that says environment, stage or release.
 * ARCHITECTURE:
 *   - Imports only the `.ts` siblings (a test cannot import a `.tsx`), then reads the `.tsx`
 *     shells as TEXT to assert what they render — which is how the "nothing else new on screen"
 *     clause becomes checkable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  lifecycleBadge,
  audienceBadge,
  tileBadges,
  LIFECYCLE_BADGE_CLASS,
  AUDIENCE_BADGE_CLASS,
} from './badges.ts';
import {
  defaultViewSurface,
  parseViewSurface,
  tilesForSurface,
  VIEW_SURFACES,
  VIEW_SURFACE_HINTS,
} from '@core/prefs/view-surface-pure';
import {
  goLiveButtonLabel,
  goLiveDialogCopy,
  retireDialogCopy,
  type GoLivePreviewDto,
} from './go-live-client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHA = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);

const draft = { draft: SHA };
const testing = { draft: SHA, testing: SHA };
const live = { draft: SHA, live: SHA };
const liveEdited = { draft: OTHER, live: SHA };

// ------------------------------------------------------------ the two badges ---

test('V1.3: the lifecycle badge is one of exactly three words, each with its own class', () => {
  assert.equal(lifecycleBadge(draft).label, 'Draft');
  assert.equal(lifecycleBadge(testing).label, 'Testing');
  assert.equal(lifecycleBadge(live).label, 'Live');
  assert.deepEqual(Object.values(LIFECYCLE_BADGE_CLASS), ['lc-draft', 'lc-testing', 'lc-live']);
  for (const l of [draft, testing, live]) {
    assert.match(lifecycleBadge(l).className, /^badge lc-/, 'it reuses the existing .badge skin');
    assert.ok(lifecycleBadge(l).title.length > 20, 'and explains itself on hover');
  }
});

test('V1.3: the audience badge is one of exactly three words, on the EXISTING visibility skin', () => {
  assert.equal(audienceBadge('personal').label, 'My');
  assert.equal(audienceBadge('asset').label, 'Domain');
  assert.equal(audienceBadge('marketplace').label, 'Company');
  assert.deepEqual(Object.values(AUDIENCE_BADGE_CLASS), ['vis-personal', 'vis-shared', 'vis-certified']);
});

test('V1.3: a tile gets exactly TWO badges, lifecycle first', () => {
  const b = tileBadges(live, 'marketplace');
  assert.equal(b.length, 2);
  assert.equal(b[0].label, 'Live');
  assert.equal(b[1].label, 'Company');
});

test('a live object with unpublished edits says so in the badge tooltip, not with a fourth word', () => {
  const b = lifecycleBadge(liveEdited);
  assert.equal(b.label, 'Live', 'still exactly three possible words');
  assert.match(b.title, /draft has moved on from dddddd/);
});

// ------------------------------------------------------------ the one toggle ---

test('V1.4: the toggle has exactly two options, both explained', () => {
  assert.deepEqual([...VIEW_SURFACES], ['studio', 'run']);
  assert.deepEqual(Object.keys(VIEW_SURFACE_HINTS), ['studio', 'run']);
  for (const h of Object.values(VIEW_SURFACE_HINTS)) assert.ok(h.length > 20);
});

test('V1.4: every authoring role defaults to Studio, and an unknown role to Run', () => {
  for (const r of ['creator', 'builder', 'domain_admin', 'admin']) {
    assert.equal(defaultViewSurface(r), 'studio', r);
  }
  assert.equal(defaultViewSurface('viewer'), 'run', 'a consume-only role would land in Run');
  assert.equal(parseViewSurface('run', 'creator'), 'run', 'a saved choice wins');
  assert.equal(parseViewSurface('prod', 'creator'), 'studio', 'junk falls back to the default');
  assert.equal(parseViewSurface(undefined, 'viewer'), 'run');
});

test('V1.4: Studio shows everything; Run shows ONLY what is live — one rule, one place', () => {
  const items = [
    { id: 'a', l: live },
    { id: 'b', l: draft },
    { id: 'c', l: testing },
    { id: 'd', l: liveEdited },
  ];
  const of = (i: (typeof items)[number]) => i.l;
  assert.deepEqual(tilesForSurface(items, 'studio', of).map((i) => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(
    tilesForSurface(items, 'run', of).map((i) => i.id),
    ['a', 'd'],
    'an edited live object stays in Run — Run serves the PIN',
  );
  assert.deepEqual(tilesForSurface([], 'run', of), []);
});

// ---------------------------------------------------- the one Go-live button ---

test('V8: one button, two states — Go live, or Retire once it is live and unedited', () => {
  assert.equal(goLiveButtonLabel('draft', false), 'Go live');
  assert.equal(goLiveButtonLabel('testing', false), 'Go live');
  assert.equal(goLiveButtonLabel('live', false), 'Live');
  assert.equal(goLiveButtonLabel('live', true), 'Go live with this draft');
});

test('V8: the dialog repeats the SERVER’s sentence about what starts running', () => {
  const preview: GoLivePreviewDto = {
    object: { kind: 'agent', id: 's1', name: 'Nightly digest', head: SHA, tier: 'personal' },
    ref: SHA,
    dependencies: [],
    confirm: {
      title: 'Go live with “Nightly digest”?',
      body: 'Run will serve agent “Nightly digest” at ddddddd. From then on: its cron schedule runs the pinned definition.',
      confirmLabel: 'Go live',
    },
    blocked: null,
  };
  const copy = goLiveDialogCopy(preview);
  assert.equal(copy.title, preview.confirm.title);
  assert.equal(copy.body, preview.confirm.body);
  assert.equal(copy.confirmLabel, 'Go live');
  assert.equal(copy.danger, false, 'going live is not a destructive action');
  assert.equal(copy.confirmPhrase, undefined, 'and needs no type-to-confirm gate');
});

test('V8: a blocked go-live becomes a dialog that NAMES the culprit and offers only Close', () => {
  const copy = goLiveDialogCopy({
    object: { kind: 'dashboard', id: 'd1', name: 'Revenue', head: SHA, tier: 'personal' },
    ref: SHA,
    dependencies: [],
    confirm: { title: 'x', body: 'y', confirmLabel: 'Go live' },
    blocked: 'cannot go live: metric “Orders revenue” (m1) is Draft, not Live. Take it live first, then try again.',
  });
  assert.match(copy.title, /cannot go live yet/);
  assert.match(copy.body, /Orders revenue/);
  assert.equal(copy.confirmLabel, 'Close');
});

test('V8: retire’s dialog says nothing is deleted', () => {
  const copy = retireDialogCopy('Revenue by region', 'dashboard');
  assert.match(copy.body, /Nothing is deleted/);
  assert.equal(copy.danger, false);
});

// ------------------------------------------- nothing else new on screen ---

test('V8: the lifecycle UI is FOUR components — two badges, one toggle, one button', () => {
  const mine = readdirSync(HERE).filter((f) => f.endsWith('.tsx'));
  const added = mine.filter((f) =>
    ['LifecycleBadge.tsx', 'AudienceBadge.tsx', 'StudioRunToggle.tsx', 'GoLiveButton.tsx'].includes(f),
  );
  assert.deepEqual(added.sort(), [
    'AudienceBadge.tsx',
    'GoLiveButton.tsx',
    'LifecycleBadge.tsx',
    'StudioRunToggle.tsx',
  ]);
});

test('V8: the Go-live button reuses the ONE existing confirm dialog — no second modal', () => {
  const src = readFileSync(join(HERE, 'GoLiveButton.tsx'), 'utf8');
  assert.match(src, /useConfirm\(\)/, 'it goes through the shared ConfirmProvider');
  assert.equal(/createPortal|<dialog|role="dialog"/.test(src), false, 'and defines no dialog of its own');
  // One control on screen: Go live OR Retire, never both at once.
  const buttons = [...src.matchAll(/<button\b/g)].length;
  assert.equal(buttons, 2, 'exactly the two states of ONE control');
});

test('V8: no lifecycle UI string says environment, stage or release', () => {
  const files = readdirSync(HERE).filter((f) => /^(badges|go-live-client|useLifecycleView)\.ts$|\.tsx$/.test(f));
  const banned = /\b(environment|stage|staging|release)\b/i;
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const m of src.matchAll(/'([^'\\\n]{4,})'|`([^`\\\n$]{4,})`/g)) {
      const lit = m[1] ?? m[2];
      if (!lit.includes(' ')) continue;
      assert.equal(banned.test(lit), false, `${f}: "${lit}"`);
    }
  }
});

test('V8: the toggle renders exactly the two words and persists the choice', () => {
  const src = readFileSync(join(HERE, 'StudioRunToggle.tsx'), 'utf8');
  assert.match(src, /VIEW_SURFACES\.map/, 'the two options come from the closed set');
  assert.match(src, /useViewSurface/, 'and the choice is remembered per user');
  assert.match(src, /\{VIEW_SURFACE_LABELS\[s\]\}/, 'the labels come from the closed label table');
  assert.equal(
    [...src.matchAll(/<button\b/g)].length,
    1,
    'one <button> inside the map — exactly two rendered options, never a third control',
  );
});
