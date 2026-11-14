/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The app engineering view — and the honest statement that app source is not in git yet
 * USER STORY: As a reviewer I want the app's panel to refuse to imply a git story that does not
 *             exist: no head commit, no history, and a reason naming the mirror it really lives in
 *             and the subtree that will replace it (checklist T6, T7).
 * ARCHITECTURE:
 *   - Pure: the app read and the repository reader are module-mocked.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { vocabularyViolations } from '@core/engineering/vocabulary';
import type { EngineeringPrincipal } from '@core/engineering/types';

const APP = { id: 'app_1', slug: 'orders-cockpit', name: 'Orders cockpit', domain: 'ops', consumes: [{ kind: 'data', id: 'ds_1' }] };

mock.module('@tabs/software/lib/apps', {
  namedExports: {
    getAppForUser: async (id: string) => {
      if (id !== APP.id) { const e = new Error('App not found') as Error & { status?: number }; e.status = 404; throw e; }
      return APP;
    },
    listAppFilesForViewer: async () => ({ files: ['app.yaml', 'src/epics/orders/list/page.tsx'] }),
  },
});
/** Flipped by the second test: the state after the app writer commits `apps/<slug>/`. */
let paths: string[] = ['models/gold/gold_orders.sql'];

mock.module('@core/engineering/repo', {
  namedExports: {
    repoPaths: async () => ({ repo: 'ops', head: 'face', paths, reason: null }),
    readRepoFiles: async () => ({ repo: 'ops', head: 'face', files: [], unreadable: [], reason: 'no matching file' }),
  },
});

const { appEngineeringView, APPS_PREFIX } = await import('@tabs/software/lib/engineering');
const USER = { id: 'amir', name: 'Amir', domains: ['ops'], allDomains: ['ops'], activeDomain: 'ops', role: 'admin' } as unknown as EngineeringPrincipal;

test('T6/T7: with nothing committed the git section says so, and names the mirror and the subtree', async () => {
  const view = await appEngineeringView(USER, 'app_1');
  assert.deepEqual(vocabularyViolations(view), []);
  const git = view.sections.find((s) => s.tool === 'git');
  assert.equal(git?.artefacts.length, 0, 'no artefact may claim to be a git file when nothing is committed');
  assert.match(git?.unavailable ?? '', /is not committed in 'ops'/);
  assert.match(git?.unavailable ?? '', /os-app-files/);
  assert.match(git?.unavailable ?? '', new RegExp(`${APPS_PREFIX}orders-cockpit`));
  assert.ok((git?.caveats ?? []).some((c) => /app\.yaml/.test(c)), 'the files it does hold are listed as a caveat, not as git files');
  assert.equal(view.export?.href, null);
  assert.match(view.export?.unresolvedReason ?? '', /not in git yet/);
});

test('T7: an app the caller cannot see is `not found` — the software tab\'s uniform refusal', async () => {
  await assert.rejects(() => appEngineeringView(USER, 'app_other'), (e: Error & { status?: number }) => e.status === 404);
});

test('the same adapter tells the truth AFTER the app writer commits apps/<slug>/ — no code change needed', async () => {
  paths = ['apps/orders-cockpit/app.yaml', 'apps/orders-cockpit/src/epics/orders/list/page.tsx'];
  try {
    const view = await appEngineeringView(USER, 'app_1');
    assert.deepEqual(vocabularyViolations(view), []);
    const git = view.sections.find((s) => s.tool === 'git');
    assert.equal(git?.unavailable, undefined, 'nothing to explain once the subtree is committed');
    assert.deepEqual(
      (git?.artefacts ?? []).filter((a) => a.repoPath).map((a) => a.repoPath),
      ['apps/orders-cockpit/app.yaml', 'apps/orders-cockpit/src/epics/orders/list/page.tsx'],
    );
    assert.ok(!(git?.caveats ?? []).some((c) => /in the mirror rather than in git/.test(c)));
    assert.match(view.export?.unresolvedReason ?? '', /one-click archive/);
    assert.equal(view.export?.tool, 'git');
  } finally {
    paths = ['models/gold/gold_orders.sql'];
  }
});
