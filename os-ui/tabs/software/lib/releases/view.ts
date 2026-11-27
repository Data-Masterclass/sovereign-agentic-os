/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - one read model for the Code and runs view and its MCP twins
 * USER STORY: As an app builder I want one place that says which runs exist, which release serves Dev, each preview slot
 *             and Prod, whether I can take Dev live and why not, and whether the app needs a rebuild.
 * ARCHITECTURE:
 *   - `releasesView(app, user, env)` is what GET /api/apps/[id]/releases and the MCP tools `list_app_releases`,
 *     `list_app_runs`, `get_app_run` and the `get_software_status` handler return. Names, shas, digests and states only:
 *     never a credential, a log line or another app's data. The caller has already checked the user may see the app.
 *   - `goLive.noReviewer` (H): with a reviewing rule, nobody but the viewer (the would-be requester) may approve, read from
 *     the user directory through the kernel port (`core/policy/go-live-reviewers.ts`); "could not check" is its own field.
 *   - `canGoLive` here is advisory (the button), computed with the same functions the go-live path enforces
 *     (review.ts `prodGateRefusal`, `unreviewedGoLiveBlock`, the rule table); the path re-checks everything.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import { currentGoLiveRules, goLiveDecision, scopeOfVisibility } from '@core/policy/go-live-rules';
import { goLiveReviewerNotice } from '@core/policy/go-live-reviewers';
import type { AppEnv, AppRelease } from '@tabs/software/lib/app-builder-contracts';
import type { App } from '@tabs/software/lib/apps';
import { recordVerdict, type CheckRecord } from '@tabs/software/lib/check-record';
import { currentRelease, releasesOf, releaseTag } from '@tabs/software/lib/releases/store';
import { releaseUrl, NO_BUILDER_REASON } from '@tabs/software/lib/releases/rollout';
import { previewViews, type PreviewView, type PreviewDeps } from '@tabs/software/lib/releases/previews';
import { rollbackPlan } from '@tabs/software/lib/releases/rollback';
import { prodGateRefusal, unreviewedGoLiveBlock } from '@tabs/software/lib/review';
import { needsRebuildReason } from '@tabs/software/lib/releases/needs-rebuild';

export type RunStep = { id: string; status: string };
export type RunView = { sha: string; status: CheckRecord['status']; green: boolean; reason: string; digest: string | null; steps: RunStep[]; storyless: boolean; criteria: { pass: number; fail: number; truncated: boolean } | null; runRef: string | null; startedAt: string; finishedAt: string | null };
export type ReleaseView = AppRelease & { url: string | null; tag: string };
export type ReleasesView = {
  appId: string;
  env: AppEnv;
  builder: { configured: boolean; reason: string | null };
  urls: { dev: string | null; prod: string | null };
  current: ReleaseView | null;
  releases: ReleaseView[];
  previews: PreviewView[];
  rollback: { possible: boolean; targetId: string | null; migrationsSince: string[] };
  /** `noReviewer`: nobody but the viewer may approve this go-live (H); `reviewersUnchecked`: why that could not be checked. */
  goLive: { ok: boolean; reason: string | null; reviewer: string; scope: string; pendingCardId: string | null; noReviewer: string | null; reviewersUnchecked: string | null };
  needsRebuild: { reason: string } | null;
  runs: RunView[];
};

export function runView(rec: CheckRecord): RunView {
  const v = recordVerdict(rec, rec.sha);
  const crit = rec.criteria ? Object.values(rec.criteria.results).reduce((a, c) => ({ pass: a.pass + c.pass, fail: a.fail + c.fail }), { pass: 0, fail: 0 }) : null;
  return {
    sha: rec.sha,
    status: rec.status,
    green: v.green,
    reason: v.reason,
    digest: rec.digest ?? null,
    steps: rec.checks.map((c) => ({ id: c.id, status: c.status })),
    storyless: rec.storyless === true,
    criteria: crit ? { ...crit, truncated: rec.criteria?.truncated === true } : null,
    runRef: rec.runRef,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  };
}

const releaseViewOf = (app: App, r: AppRelease): ReleaseView => ({ ...r, url: r.state === 'running' ? releaseUrl(app, r.env, r.slot) : null, tag: releaseTag(r.env, r.id) });

export async function releasesView(app: App, user: CurrentUser, env: AppEnv, deps: PreviewDeps = {}): Promise<ReleasesView> {
  const scope = scopeOfVisibility(app.visibility);
  const rules = await currentGoLiveRules();
  const d = goLiveDecision(rules, 'app', scope, app.domain);
  const dev = currentRelease(app, 'dev');
  const gate = prodGateRefusal(app, dev) ?? unreviewedGoLiveBlock(app, scope);
  const plan = rollbackPlan(app, env);
  const cur = currentRelease(app, env);
  const who = d.autoApprove ? null : await goLiveReviewerNotice(rules, { kind: 'app', scope, domain: app.domain, requestedBy: user.id });
  return {
    appId: app.id,
    env,
    builder: config.appRegistry ? { configured: true, reason: null } : { configured: false, reason: NO_BUILDER_REASON },
    urls: { dev: currentRelease(app, 'dev') ? releaseUrl(app, 'dev') : null, prod: currentRelease(app, 'prod') ? releaseUrl(app, 'prod') : null },
    current: cur ? releaseViewOf(app, cur) : null,
    releases: releasesOf(app, env).map((r) => releaseViewOf(app, r)),
    previews: env === 'dev' ? await previewViews(app, deps) : [],
    rollback: { possible: !!plan, targetId: plan?.target.id ?? null, migrationsSince: plan?.migrationsSince ?? [] },
    goLive: { ok: !gate, reason: gate, reviewer: d.reviewer, scope, pendingCardId: app.deploy.state === 'review' ? app.deploy.reviewCardId : null, noReviewer: who?.notice ?? null, reviewersUnchecked: who && !who.checked ? who.reason : null },
    needsRebuild: app.deploy.state === 'needs-rebuild' ? { reason: (await needsRebuildReason(app)) ?? '' } : null,
    runs: (app.checks ?? []).slice(0, 20).map(runView),
  };
}
