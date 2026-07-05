/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_GROUPS } from '@/lib/tabs';
import { listTutorials, TUTORIAL_EXEMPT_ROUTES } from './registry.ts';

/**
 * The completeness TRIPWIRE: a future tab cannot ship without a tutorial.
 *
 * Source of truth on both sides is real: the sidebar's `TAB_GROUPS` (what
 * students actually see) vs the tutorial registry (matched by route). Every
 * canonical OS tab must have a tutorial OR a documented exemption in
 * `TUTORIAL_EXEMPT_ROUTES`. Platform-group tabs are exempt as a class — they
 * are operator consoles (admins/builders running the OS), not student golden
 * paths; see the note on `TUTORIAL_EXEMPT_ROUTES` in registry.ts.
 */

const tutorialRoutes = new Set(listTutorials().map((t) => t.route));
const osGroup = TAB_GROUPS.find((g) => !g.heading);
const platformGroup = TAB_GROUPS.find((g) => g.heading === 'Platform');

test('TRIPWIRE: every canonical OS tab has a tutorial or a documented exemption', () => {
  assert.ok(osGroup, 'canonical OS tab group (the heading-less first group) not found');
  for (const tab of osGroup!.tabs) {
    if (!tab.href) continue; // stub ("soon") — gets a tutorial when it ships a surface
    const covered = tutorialRoutes.has(tab.href);
    const exempt = tab.href in TUTORIAL_EXEMPT_ROUTES;
    assert.ok(
      covered || exempt,
      `nav tab "${tab.label}" (${tab.href}) has NO tutorial and NO documented exemption — ` +
        `author lib/tutorials/content/<path>.ts and register it, or add the route to ` +
        `TUTORIAL_EXEMPT_ROUTES with a reason`,
    );
    assert.ok(
      !(covered && exempt),
      `"${tab.label}" (${tab.href}) is both covered and exempt — remove the stale exemption`,
    );
  }
});

test('every exemption is a real nav tab with a real reason (no stale entries)', () => {
  const allHrefs = new Set(
    TAB_GROUPS.flatMap((g) => g.tabs)
      .map((t) => t.href)
      .filter(Boolean),
  );
  for (const [route, reason] of Object.entries(TUTORIAL_EXEMPT_ROUTES)) {
    assert.ok(allHrefs.has(route), `exempt route "${route}" is not a nav tab — stale entry`);
    assert.ok(
      reason.trim().length >= 20,
      `exemption for "${route}" needs a documented reason, not a shrug`,
    );
  }
});

test('platform-group class exemption stays honest: a console with a tutorial is not double-listed', () => {
  assert.ok(platformGroup, 'Platform tab group not found');
  for (const tab of platformGroup!.tabs) {
    if (!tab.href) continue;
    // Class-exempt consoles must not ALSO sit in the explicit exemption list —
    // one documented mechanism per tab, so the picture stays auditable.
    assert.ok(
      !(tab.href in TUTORIAL_EXEMPT_ROUTES),
      `platform console "${tab.label}" is class-exempt; remove it from TUTORIAL_EXEMPT_ROUTES`,
    );
  }
});

test('every tutorial route points at a real nav tab', () => {
  const allHrefs = new Set(
    TAB_GROUPS.flatMap((g) => g.tabs)
      .map((t) => t.href)
      .filter(Boolean),
  );
  for (const def of listTutorials()) {
    assert.ok(
      allHrefs.has(def.route),
      `tutorial "${def.key}" routes to "${def.route}", which is not a nav tab`,
    );
  }
});
