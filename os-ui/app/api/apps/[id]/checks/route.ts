/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The "Run checks" button on an app in the Software tab (Software Factory CI, trigger 2 of 3: a push and
 * `verify_app_gates` are the others). A SHELL over `runAppTests`, the same function the MCP tool calls, so
 * all three triggers are one code path: one Tekton run per commit, recorded against the commit.
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getAppForUser } from '@tabs/software/lib/apps';
import { readAppTreeState, appProjectGitEnabled } from '@tabs/software/lib/git-commit';
import { runAppTests } from '@tabs/software/lib/review';
import { syncAppChecks, watchChecks } from '@tabs/software/lib/checks-sync';

export const dynamic = 'force-dynamic';

/** Per-commit check records of the app, newest first, with the commit that is head now. Running ones are re-read from Tekton. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const app = await getAppForUser(params.id, user);
  await syncAppChecks(app);
  const state = appProjectGitEnabled() ? await readAppTreeState(app) : null;
  return NextResponse.json({ checks: app.checks ?? [], head: state?.kind === 'tree' ? state.sha : null });
}, { defaultStatus: 500 });

/** Run the checks for the current head now. Returns at once (202) with the running record; the result lands on the app when Tekton finishes. */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const r = await runAppTests(params.id, user, { trigger: 'button', force: true, waitMs: 0 });
  if (r.record.status === 'running') {
    const app = await getAppForUser(params.id, user);
    watchChecks(app.slug, r.commit);
  }
  return NextResponse.json({ commit: r.commit, template: r.template, record: r.record, verdict: r.verdict }, { status: 202 });
}, { defaultStatus: 500 });
