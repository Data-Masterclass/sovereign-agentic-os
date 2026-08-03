/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { createApp, getAppForUser, persistApp } from '@/lib/software/apps';
import { requestDeploy, reconcileDeployApproval, reconcileDeployStatus } from './review.ts';
import type { RunnerK8s } from './runner.ts';
import { decide, listApprovals, __resetApprovals } from '@/lib/governance/approvals';

/**
 * SELF-HEAL: an app stuck in `review` whose Governance app_deploy approval was
 * ALREADY decided (an orphan from before the approve→decideDeploy write-back) must
 * reconcile to its true state on load — WITHOUT re-approving and without a live
 * in-process review card. `approved` → live; `rejected` → preview; no matching /
 * still-pending approval → unchanged. Idempotent + fail-soft.
 */

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };

/** The governance app_deploy item filed for a review card (any status). */
function govItemForCard(cardId: string) {
  return listApprovals({}).find(
    (a) => a.kind === 'app_deploy' && (a.payload as { cardId?: string })?.cardId === cardId,
  );
}

/** Reproduce the orphan: an app left in `review` after its approval was decided
 *  directly in the queue (no decideDeploy write-back), exactly like the two live
 *  stuck apps. Returns the app id + its filed governance item. */
async function orphanStuckApp(name: string, decision: 'approve' | 'reject') {
  const app = await createApp(creator, { name, template: 'nextjs-supabase' });
  const res = await requestDeploy(app.id, creator);
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') throw new Error('expected review');
  const item = govItemForCard(res.card.id);
  assert.ok(item, 'an app_deploy item was filed');
  // Decide ONLY the queue item — the pre-fix orphan: the app keeps state 'review'.
  decide(item!.id, decision, 'dana');
  const stuck = await getAppForUser(app.id, creator);
  assert.equal(stuck.deploy.state, 'review');
  assert.equal(stuck.deploy.reviewCardId, res.card.id);
  return app.id;
}

test('RECONCILE: review app with an APPROVED deploy approval heals → live on load', async () => {
  __resetApprovals();
  const appId = await orphanStuckApp('Reconcile Approved', 'approve');

  const app = await getAppForUser(appId, creator);
  const healed = await reconcileDeployApproval(app);
  assert.equal(healed, true, 'the app was reconciled');
  assert.equal(app.deploy.state, 'live', 'review → live');
  assert.equal(app.deploy.reviewCardId, null, 'reviewCardId cleared');
  assert.ok(app.deploy.releases > 0, 'a go-live shipped a release');
  assert.ok(app.deploy.approved, 'the approved envelope is recorded');

  // Idempotent: a second reconcile is a no-op (already live, no reviewCardId).
  const again = await reconcileDeployApproval(app);
  assert.equal(again, false);
  assert.equal(app.deploy.state, 'live');
});

test('RECONCILE: review app with a REJECTED deploy approval heals → preview on load', async () => {
  __resetApprovals();
  const appId = await orphanStuckApp('Reconcile Rejected', 'reject');

  const app = await getAppForUser(appId, creator);
  const healed = await reconcileDeployApproval(app);
  assert.equal(healed, true);
  assert.equal(app.deploy.state, 'preview', 'review → preview');
  assert.equal(app.deploy.reviewCardId, null);
});

test('RECONCILE: no-op when the approval is still pending (stays in review)', async () => {
  __resetApprovals();
  const app = await createApp(creator, { name: 'Reconcile Pending', template: 'nextjs-supabase' });
  const res = await requestDeploy(app.id, creator);
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') return;

  const loaded = await getAppForUser(app.id, creator);
  const healed = await reconcileDeployApproval(loaded);
  assert.equal(healed, false, 'a pending approval does not heal');
  assert.equal(loaded.deploy.state, 'review', 'left in review');
  assert.equal(loaded.deploy.reviewCardId, res.card.id);
});

// -------------------------------------------------- Self-heal a missing runner --

/**
 * The runner NAMESPACE + object paths the status reconcile touches (explicit so
 * the mock is config-independent). A recording k8s mock whose GET on the app's
 * Deployment starts as 404 (`absent`) and — after a re-provision (POST-create) —
 * reports a running pod, exactly like a healed transient-unreachable orphan.
 */
const HEAL_OPTS = { namespace: 'agentic-apps', ingressClass: 'nginx', tlsIssuer: 'letsencrypt-prod' };

/** A stateful mock: the Deployment is ABSENT until it is POSTed, then RUNNING. */
function healMockK8s(depPath: string) {
  const calls: { method: string; path: string }[] = [];
  let created = false;
  const running = { spec: { replicas: 1 }, status: { readyReplicas: 1 } };
  const client: RunnerK8s = async (method, path) => {
    calls.push({ method, path });
    if (method === 'GET' && path === `/api/v1/namespaces/${HEAL_OPTS.namespace}`) return { status: 200, body: {} };
    if (method === 'POST') { if (path.endsWith('/deployments')) created = true; return { status: 201, body: {} }; }
    if (method === 'PUT') return { status: 200, body: {} };
    if (method === 'GET' && path === depPath) {
      return created ? { status: 200, body: running } : { status: 404, body: {} };
    }
    if (method === 'GET') return { status: 404, body: {} }; // svc/ingress absent → POST-create
    return { status: 0, body: {} };
  };
  return { client, calls };
}

test('SELF-HEAL: a live app whose runner is ABSENT is re-provisioned on status poll', async () => {
  __resetApprovals();
  // Drive an app to genuinely-live (approved) via the reconcile seam.
  const appId = await orphanStuckApp('Self Heal Missing Runner', 'approve');
  let app = await getAppForUser(appId, creator);
  await reconcileDeployApproval(app);
  assert.equal(app.deploy.state, 'live', 'app is approved-live');

  const depPath = `/apis/apps/v1/namespaces/${HEAL_OPTS.namespace}/deployments/app-${app.slug}`;
  const { client, calls } = healMockK8s(depPath);

  const { status } = await reconcileDeployStatus(appId, creator, { ...HEAL_OPTS, k8s: client });

  // It saw the absent runner and re-provisioned it (POSTed a Deployment), then the
  // re-read reports the now-running pod — no fabricated URL, a real served state.
  assert.ok(calls.some((c) => c.method === 'POST' && c.path.endsWith('/deployments')), 're-provisioned the Deployment');
  assert.equal(status.phase, 'running', 're-read sees the healed pod running');
  app = await getAppForUser(appId, creator);
  assert.equal(app.pipeline.live, 'ok', 'pipeline.live flips to ok once the pod runs');
  assert.ok(app.deploy.previewUrl, 'a served URL is now recorded');
});

test('SELF-HEAL: offline cluster (status 0) is NOT healed — stays honestly pending', async () => {
  __resetApprovals();
  const appId = await orphanStuckApp('Self Heal Offline', 'approve');
  let app = await getAppForUser(appId, creator);
  await reconcileDeployApproval(app);

  // Every k8s call resolves offline (status 0) → never claims a heal or a URL.
  const offline: RunnerK8s = async () => ({ status: 0, body: {} });
  const { status } = await reconcileDeployStatus(appId, creator, { ...HEAL_OPTS, k8s: offline });
  assert.equal(status.phase, 'offline');
  app = await getAppForUser(appId, creator);
  assert.equal(app.deploy.previewUrl ?? null, null, 'no fabricated URL when unreachable');
});

test('RECONCILE: no-op when there is NO matching approval (left unchanged)', async () => {
  __resetApprovals();
  const app = await createApp(creator, { name: 'Reconcile Orphan Card', template: 'nextjs-supabase' });
  // Force a review state whose card has no governance approval at all.
  app.deploy.state = 'review';
  app.deploy.reviewCardId = 'rev_does_not_exist';
  await persistApp(app);

  const loaded = await getAppForUser(app.id, creator);
  const healed = await reconcileDeployApproval(loaded);
  assert.equal(healed, false);
  assert.equal(loaded.deploy.state, 'review', 'unchanged when nothing matches');
});
