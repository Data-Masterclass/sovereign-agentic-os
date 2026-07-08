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
 * student-facing tab must have a tutorial OR a documented exemption in
 * `TUTORIAL_EXEMPT_ROUTES`. Admin-group tabs (Components, Terminal, Admin,
 * About / Licenses — those with minRole='admin') are exempt as a class:
 * they are operator consoles for admins running the OS, not student golden
 * paths; see the note on `TUTORIAL_EXEMPT_ROUTES` in registry.ts.
 * Settings and Tutorials (no minRole, but in the Admin group) are listed
 * in TUTORIAL_EXEMPT_ROUTES individually.
 */

const tutorialRoutes = new Set(listTutorials().map((t) => t.route));

// All groups that contain student-facing tabs (excludes operator-only consoles).
// Admin-only tabs (minRole='admin') are class-exempt; Settings/Tutorials are
// individually exempt via TUTORIAL_EXEMPT_ROUTES.
const allStudentTabs = TAB_GROUPS
  .flatMap((g) => g.tabs)
  .filter((t) => t.minRole !== 'admin');

// The operator-console tabs that are class-exempt from the tutorial requirement.
const adminConsoleTabs = TAB_GROUPS
  .flatMap((g) => g.tabs)
  .filter((t) => t.minRole === 'admin');

test('TRIPWIRE: every student-facing nav tab has a tutorial or a documented exemption', () => {
  for (const tab of allStudentTabs) {
    if (!tab.href) continue; // stub ("soon") — gets a tutorial when it ships
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

test('admin-console class exemption stays honest: a console with a tutorial is not double-listed', () => {
  assert.ok(adminConsoleTabs.length > 0, 'admin-only console tabs must exist (minRole=admin)');
  for (const tab of adminConsoleTabs) {
    if (!tab.href) continue;
    // Class-exempt consoles must not ALSO sit in the explicit exemption list —
    // one documented mechanism per tab, so the picture stays auditable.
    assert.ok(
      !(tab.href in TUTORIAL_EXEMPT_ROUTES),
      `admin console "${tab.label}" is class-exempt; remove it from TUTORIAL_EXEMPT_ROUTES`,
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
