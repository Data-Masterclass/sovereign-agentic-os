/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `apps/` is reserved BEFORE any whole-tree writer runs (review H-3)
 * USER STORY: As an app owner my source tree must survive the data side's boot reconcile. The
 *             reservation used to be registered in a floating IIFE at the END of `register()`,
 *             so the data whole-tree reconcile could run FIRST and delete every `apps/**` tree —
 *             the D-1 defect repeated.
 * ARCHITECTURE:
 *   - TWO assertions, because "it is registered somewhere" is not the property that matters:
 *       1. ORDER, over the boot file's source: `reserveSubtree('apps/')` appears in the TOP block,
 *          BEFORE the data boot reconcile, and the reconcile is guarded on the reservation
 *          actually being in the registry. A boot file cannot be imported in a test (it would run
 *          the whole boot), so the order is pinned where it lives: in the text.
 *       2. SEMANTICS, over a real repo: with the reservation a whole-tree `commitTree` KEEPS
 *          `apps/**`, and without it the same commit DELETES it — which is what makes the
 *          ordering load-bearing rather than decorative.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitTree,
  commitSubtree,
  listTree,
  reserveSubtree,
  reservedSubtrees,
  __clearReservedSubtrees,
} from '@core/infra/git-store';
import { APPS_PREFIX, installAppTreeReservation } from './git-commit.ts';

const OS_UI = join(import.meta.dirname, '..', '..', '..');

let reposDir = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-reserve-'));
});
after(() => rmSync(reposDir, { recursive: true, force: true }));

const opts = () => ({ reposDir, author: { name: 'Data', email: 'data@os.local' }, message: 'data(eng): regenerate — via ui:data' });

test('ORDER: the boot file reserves `apps/` in the TOP block, before the data boot reconcile', () => {
  const src = readFileSync(join(OS_UI, 'instrumentation.ts'), 'utf8');
  const reserveApps = src.indexOf("reserveSubtree('apps/')");
  const reserveAgents = src.indexOf("reserveSubtree('agents/')");
  const reconcile = src.indexOf('reconcileDataProjectsAtBoot');
  assert.ok(reserveApps > 0, "instrumentation.ts calls reserveSubtree('apps/')");
  assert.ok(reconcile > 0, 'instrumentation.ts runs the data boot reconcile');
  assert.ok(
    reserveApps < reconcile,
    "reserveSubtree('apps/') must come BEFORE reconcileDataProjectsAtBoot — a whole-tree reconcile with apps/ unreserved deletes every app's source",
  );
  // It belongs in the SAME block as the agents reservation, not in a trailing IIFE.
  assert.ok(Math.abs(reserveApps - reserveAgents) < 1200, 'it sits beside the agents reservation in the top block');
  assert.ok(
    !/installAppTreeReservation\(\)/.test(src),
    'the floating late IIFE is gone — the reservation is not registered after the reconcile',
  );
  // And the reconcile is GUARDED on the reservation really being registered, not on an argument.
  assert.match(src, /const appsReserved = reserved\.includes\('apps\/'\);/);
  assert.match(src, /if \(dataHookInstalled && agentsHookInstalled && appsReserved\) \{/);
});

test('SEMANTICS: with the reservation a whole-tree commit KEEPS apps/**; without it, it DELETES it', async () => {
  // An app commits its tree…
  __clearReservedSubtrees();
  reserveSubtree(APPS_PREFIX);
  await commitSubtree('eng', 'apps/invoices', new Map([['apps/invoices/app.yaml', 'name: Invoices\n']]), opts());

  // …then the data generator commits the WHOLE tree, mentioning nothing under apps/.
  await commitTree('eng', new Map([['dbt_project.yml', 'name: eng\n']]), opts());
  let paths = (await listTree('eng', 'main', { reposDir })).map((e) => e.path);
  assert.ok(paths.includes('apps/invoices/app.yaml'), 'the reservation KEPT the app tree');
  assert.ok(paths.includes('dbt_project.yml'));

  // Now prove the reservation is load-bearing: the same commit WITHOUT it deletes the app tree.
  __clearReservedSubtrees();
  await commitTree('eng', new Map([['dbt_project.yml', 'name: eng\nversion: 2\n']]), opts());
  paths = (await listTree('eng', 'main', { reposDir })).map((e) => e.path);
  assert.ok(!paths.includes('apps/invoices/app.yaml'), 'unreserved, a whole-tree commit DELETES the app tree — this is the bug H-3 prevents');

  // `installAppTreeReservation` remains the idempotent helper the boot block and tests share.
  installAppTreeReservation();
  assert.ok(reservedSubtrees().includes('apps/'));
});
