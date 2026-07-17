/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { createApp } from '@/lib/software/apps';
import { requestDeploy, getReviewCard } from './review.ts';
import { applyEffect } from '@/lib/governance/effects';
import { buildEffectDeps } from '@/lib/governance/ladder';
import { decide, listApprovals, __resetApprovals } from '@/lib/governance/approvals';

/**
 * REGRESSION: approving a Software deploy-review in Policies & Approvals must
 * write BACK to the software release record — the app's deploy state must flip
 * review → live (and reject → preview). Before the fix, `applyEffect` had no
 * `app_deploy` case (fell to the mock default), so the queue item was marked
 * approved but the Software app stayed stuck "awaiting review".
 */

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
// domain_admin satisfies both the governance approverRole (app_deploy → domain_admin)
// and the software `decideDeploy` seam (Builder+ in the card's domain).
const approver: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };

/** Find the pending governance app_deploy item filed for a given review card. */
function govItemForCard(cardId: string) {
  return listApprovals({ status: 'pending' }).find(
    (a) => a.kind === 'app_deploy' && (a.payload as { cardId?: string })?.cardId === cardId,
  );
}

test('APPROVAL-SYNC: approving the app_deploy governance item flips the software release review → live', async () => {
  __resetApprovals();
  const app = await createApp(creator, { name: 'Approval Sync Live', template: 'nextjs-supabase' });

  // Creator requests the first domain deploy → a review card + a governance item.
  const res = await requestDeploy(app.id, creator);
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') return;
  assert.equal(res.app.deploy.state, 'review');
  assert.equal(getReviewCard(res.card.id)?.decision, 'pending');

  // The item is queued in the Governance inbox (Policies & Approvals).
  const item = govItemForCard(res.card.id);
  assert.ok(item, 'an app_deploy governance item was enqueued for the review card');

  // Approve it the way the /governance/approvals route does: decide → applyEffect.
  const decided = decide(item!.id, 'approve', approver.id);
  assert.equal(decided?.status, 'approved');
  const effect = await applyEffect(
    decided!,
    { id: approver.id, role: approver.role, domains: approver.domains },
    buildEffectDeps(),
  );
  assert.equal(effect.ok, true);

  // THE FIX: the software release record flipped — no more "awaiting review".
  assert.equal(getReviewCard(res.card.id)?.decision, 'approved');
  const { getAppForUser } = await import('@/lib/software/apps');
  const after = await getAppForUser(app.id, creator);
  assert.equal(after.deploy.state, 'live', 'app deploy state flips review → live');
  assert.equal(after.deploy.reviewCardId, null);
  assert.ok(after.deploy.releases > 0, 'an approved go-live ships a release');
});

test('APPROVAL-SYNC: rejecting the app_deploy governance item flips the software release review → preview', async () => {
  __resetApprovals();
  const app = await createApp(creator, { name: 'Approval Sync Reject', template: 'nextjs-supabase' });

  const res = await requestDeploy(app.id, creator);
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') return;

  const item = govItemForCard(res.card.id);
  assert.ok(item);

  // Mirror the route's reject branch: decide(reject) then run the deploy-deny seam.
  const decided = decide(item!.id, 'reject', approver.id);
  assert.equal(decided?.status, 'rejected');
  await buildEffectDeps().decideDeploy!(
    res.card.id,
    { id: approver.id, role: approver.role, domains: approver.domains },
    'deny',
  );

  assert.equal(getReviewCard(res.card.id)?.decision, 'denied');
  const { getAppForUser } = await import('@/lib/software/apps');
  const after = await getAppForUser(app.id, creator);
  assert.equal(after.deploy.state, 'preview', 'a rejected deploy returns to the free preview loop');
  assert.equal(after.deploy.reviewCardId, null);
});
