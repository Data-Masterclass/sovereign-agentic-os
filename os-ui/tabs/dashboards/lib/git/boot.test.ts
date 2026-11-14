/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        dashboards
 * FEATURE:    The boot wiring that keeps `dashboards/**` alive in the domain repo
 * USER STORY: As a maintainer I want the ONE ordering fact that could silently delete every
 *             dashboard in every repository pinned by a test, not by a comment.
 * ARCHITECTURE:
 *   - `core/infra/git-store.ts` `commitTree` writes the WHOLE tree, so the dbt generator's commit
 *     deletes anything it does not know about unless the prefix is RESERVED first. The agents side
 *     learned this the same way; the literal in `instrumentation.ts` is a string, so only a test
 *     can keep it equal to `DASHBOARDS_PREFIX`.
 *   - Reads `instrumentation.ts` as TEXT. It is a Next instrumentation entrypoint and importing it
 *     would run the whole boot sequence; a test may not import a route or an entrypoint anyway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARDS_PREFIX } from '@tabs/dashboards/lib/git/generate';
import { installDashboardCommitHook, __setDashboardProjectGitForTests } from '@tabs/dashboards/lib/git/commit';
import { reservedSubtrees, __clearReservedSubtrees } from '@core/infra/git-store';

/** `os-ui/instrumentation.ts` — this file is at `os-ui/tabs/dashboards/lib/git/`. */
const UI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const instrumentation = readFileSync(join(UI, 'instrumentation.ts'), 'utf8');

test('instrumentation.ts reserves the EXACT prefix the generator writes', () => {
  assert.ok(
    instrumentation.includes(`reserveSubtree('${DASHBOARDS_PREFIX}')`),
    `instrumentation.ts must call reserveSubtree('${DASHBOARDS_PREFIX}') — without it the dbt ` +
      'generator’s next whole-tree commit DELETES every dashboard in every domain repository',
  );
});

test('the reservation happens BEFORE the data boot reconcile, which is a whole-tree commit', () => {
  const reserve = instrumentation.indexOf(`reserveSubtree('${DASHBOARDS_PREFIX}')`);
  const reconcile = instrumentation.indexOf('DATA boot reconcile');
  assert.ok(reserve > 0 && reconcile > 0, 'both anchors must exist');
  assert.ok(reserve < reconcile, 'the reservation must come first, or the reconcile commits the subtree’s deletion');
});

test('instrumentation.ts installs the dashboards commit hook', () => {
  assert.match(instrumentation, /installDashboardCommitHook\(/);
  assert.match(instrumentation, /tabs\/dashboards\/lib\/git\/commit\.ts/);
});

test('installing the hook reserves the subtree itself — defence in depth', () => {
  __clearReservedSubtrees();
  try {
    __setDashboardProjectGitForTests(true);
    const off = installDashboardCommitHook({ mirror: false, capture: () => [] });
    assert.ok(reservedSubtrees().includes(DASHBOARDS_PREFIX));
    off();
  } finally {
    __setDashboardProjectGitForTests(null);
    __clearReservedSubtrees();
  }
});

// ---------------------------------------- H-4: the boot reconcile and its guards ---

test('H-4 — instrumentation.ts runs the dashboards boot reconcile, hydrating the store first', () => {
  assert.match(instrumentation, /reconcileDashboardsAtBoot\(/);
  assert.match(instrumentation, /tabs\/dashboards\/lib\/git\/reconcile\.ts/);
  const hydrate = instrumentation.indexOf("await import('./tabs/dashboards/lib/store.ts')");
  const reconcile = instrumentation.indexOf('reconcileDashboardsAtBoot(');
  assert.ok(hydrate > 0 && hydrate < reconcile, 'the store must be hydrated before the reconcile runs');
  // And it only runs when the hook installed, so `dashboards/` is reserved.
  assert.match(instrumentation, /if \(dashboardsHookInstalled\) \{/);
});

test('H-4 — the reconcile REFUSES to run on an unverified registry', async () => {
  const { reconcileDashboardProjects } = await import('@tabs/dashboards/lib/git/reconcile');
  __setDashboardProjectGitForTests(true);
  try {
    for (const state of ['failed', 'pending'] as const) {
      let committed = 0;
      const outcomes = await reconcileDashboardProjects({
        hydration: () => state,
        domains: () => ['analytics'],
        repos: async () => [{ name: 'analytics' }],
        capture: async () => [],
        committer: async () => {
          committed += 1;
          return { sha: 'x', changed: true };
        },
      });
      // An empty store whose mirror was unreachable is indistinguishable from a tenant with no
      // dashboards; committing the former DELETES every dashboard directory in every domain.
      assert.deepEqual(outcomes, [], state);
      assert.equal(committed, 0, `nothing may be committed while hydration is '${state}'`);
    }
  } finally {
    __setDashboardProjectGitForTests(null);
  }
});

test('H-4 — a hydrated registry reconciles every domain, and reports a no-op honestly', async () => {
  const { reconcileDashboardProjects, RECONCILE_REASON, RECONCILE_SURFACE, PLATFORM_ACTOR } = await import('@tabs/dashboards/lib/git/reconcile');
  __setDashboardProjectGitForTests(true);
  try {
    const calls: { domain: string; message: string }[] = [];
    const outcomes = await reconcileDashboardProjects({
      hydration: () => 'hydrated',
      domains: () => ['analytics'],
      // A repo with no dashboards in the store but WITH the subtree is still a target, so a
      // deletion that happened while the flag was off gets committed.
      repos: async () => [{ name: 'analytics' }, { name: 'finance' }, { name: 'other' }],
      hasDashboardsSubtree: async (d) => d === 'finance',
      capture: async () => [],
      committer: async (domain, _prefix, _files, opts) => {
        calls.push({ domain, message: opts.message });
        return { sha: `sha-${domain}`, changed: domain === 'analytics' };
      },
    });
    assert.deepEqual(outcomes.map((o) => o.domain), ['analytics', 'finance']);
    assert.equal(outcomes[0].changed, true);
    assert.equal(outcomes[1].changed, false, 'a no-op domain is reported, not hidden');
    assert.ok(!outcomes.some((o) => o.domain === 'other'), 'a repo with no dashboards and no subtree is not a target');
    // Attributed to the PLATFORM, with the reason that marks it a catch-up rather than an action.
    assert.equal(PLATFORM_ACTOR.id, 'system');
    assert.match(calls[0].message, new RegExp(`OS-Surface: ${RECONCILE_SURFACE}`));
    assert.match(calls[0].message, /reconcile dashboards/);
    assert.equal(RECONCILE_REASON, 'boot-reconcile');
  } finally {
    __setDashboardProjectGitForTests(null);
  }
});

test('H-4 — a destructive-delta refusal is REPORTED, never worked around', async () => {
  const { reconcileDashboardProjects } = await import('@tabs/dashboards/lib/git/reconcile');
  __setDashboardProjectGitForTests(true);
  try {
    const outcomes = await reconcileDashboardProjects({
      hydration: () => 'hydrated',
      domains: () => ['analytics'],
      repos: async () => [],
      capture: async () => [],
      committer: async () => {
        // This is what `commitSubtree` throws for a boot-reconcile commit that would delete most
        // of its own tree while adding nothing. The reconcile must surface it, not swallow it.
        throw new Error('DestructiveReconcileError: would delete 9 of 10 tracked files');
      },
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].changed, false);
    assert.match(outcomes[0].error ?? '', /DestructiveReconcileError/);
  } finally {
    __setDashboardProjectGitForTests(null);
  }
});

test('H-4 — the flag off ⇒ the reconcile does nothing at all', async () => {
  const { reconcileDashboardProjects } = await import('@tabs/dashboards/lib/git/reconcile');
  __setDashboardProjectGitForTests(false);
  try {
    assert.deepEqual(await reconcileDashboardProjects({ hydration: () => 'hydrated' }), []);
  } finally {
    __setDashboardProjectGitForTests(null);
  }
});
