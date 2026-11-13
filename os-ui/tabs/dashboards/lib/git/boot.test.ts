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
