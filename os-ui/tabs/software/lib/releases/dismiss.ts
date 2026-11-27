/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - an admin dismisses a REJECTED post-hoc card that would otherwise block go-live forever
 * USER STORY: As an admin I want to clear a rejected "change without review" card whose change was already undone (an OS
 *             commit, or a later legitimate edit the revert detection cannot see), with a written reason that stays in
 *             the audit log, so the app can go live in Domain or Company scope again.
 * ARCHITECTURE: (spec 5, 9; workstream B's post-hoc cards, review of #396)
 *   - Only a card that is post-hoc, `rejected` and still in `App.unreviewed` qualifies: a PENDING card is decided through
 *     B's `decide_requirement`, never dismissed, and an approved one is not unreviewed.
 *   - Admin only, never an app token or an agent run (`dismiss_posthoc_card` is agent-forbidden), a substantive reason
 *     (AUDITED_OVERRIDE_REASON_MIN characters), under B's per-app proposal lock (so a push re-deriving the unreviewed
 *     set cannot interleave). The card itself is kept as it is; only its id leaves `App.unreviewed`, and B's
 *     `nextUnreviewed` never re-adds a rejected card that is not already unreviewed. Hash-chained audit row.
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { assertAppBuilderEnabled } from '@core/kernel/app-builder-flag';
import { roleAtLeast } from '@core/kernel/session';
import { AUDITED_OVERRIDE_REASON_MIN } from '@core/policy/approvals';
import { record as recordAudit } from '@core/policy/audit';

const withStatus = (e: Error, status: number) => Object.assign(e, { status });

export type DismissResult = { appId: string; proposalId: string; unreviewed: string[] };

export async function dismissRejectedPosthoc(appId: string, proposalId: string, user: CurrentUser, reason: string): Promise<DismissResult> {
  assertAppBuilderEnabled();
  const { getAppForUser, getAppByIdInternal, persistApp } = await import('@tabs/software/lib/apps');
  await getAppForUser(appId, user); // existence first: an unseeable app is not_found
  if (!roleAtLeast(user.role, 'admin') || user.via) throw withStatus(new Error('only an administrator can dismiss a rejected post-hoc card'), 403);
  const why = String(reason ?? '').trim();
  if (why.length < AUDITED_OVERRIDE_REASON_MIN) throw withStatus(new Error(`dismissing a card needs a written reason of at least ${AUDITED_OVERRIDE_REASON_MIN} characters (it is the permanent record)`), 400);
  const { withProposalLock } = await import('@tabs/software/lib/stories/proposals');
  return withProposalLock(appId, async () => {
    const app = await getAppByIdInternal(appId);
    if (!app) throw withStatus(new Error('App not found'), 404);
    const card = (app.proposals ?? []).find((p) => p.id === proposalId);
    if (!card) throw withStatus(new Error(`no card ${proposalId} on this app`), 404);
    if (!card.posthoc || card.status !== 'rejected') throw withStatus(new Error(`card ${proposalId} is ${card.posthoc ? card.status : 'not a post-hoc card'}; only a REJECTED post-hoc card can be dismissed (decide a pending card instead)`), 409);
    if (!(app.unreviewed ?? []).includes(proposalId)) throw withStatus(new Error(`card ${proposalId} no longer blocks a go-live`), 409);
    app.unreviewed = (app.unreviewed ?? []).filter((id) => id !== proposalId);
    await persistApp(app);
    recordAudit({
      actor: user.id,
      action: 'deploy',
      subject: app.id,
      domain: app.domain,
      reason: why,
      detail: { kind: 'app.posthoc.dismiss', proposalId, classification: card.classification, commits: card.commitShas ?? [], role: user.role },
    });
    return { appId: app.id, proposalId, unreviewed: app.unreviewed };
  });
}
