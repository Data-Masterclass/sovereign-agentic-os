/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { createApp } from '@/lib/software/apps';
import { startPreview, requestDeploy, decideDeploy, scopeBroadened } from './review.ts';
import { consumeResource } from './lifecycle.ts';
import { commitToApp } from './server.ts';

const creator: CurrentUser = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'bob', name: 'Bob', domains: ['sales'], role: 'builder' };
const otherDomainBuilder: CurrentUser = { id: 'eve', name: 'Eve', domains: ['hr'], role: 'builder' };

async function expectStatus(p: Promise<unknown>, status: number, re?: RegExp) {
  await assert.rejects(p, (e: Error & { status?: number }) => {
    assert.equal(e.status, status);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test('GATE: preview is free; first deploy opens a Builder review card', async () => {
  const app = await createApp(creator, { name: 'Renewals Tracker R1', template: 'nextjs-supabase' });
  const previewed = await startPreview(app.id, creator);
  assert.equal(previewed.deploy.state, 'preview');
  // HONEST (Phase 1): no in-cluster runner yet → no fabricated URL claimed live.
  assert.equal(previewed.deploy.previewUrl, null);

  const res = await requestDeploy(app.id, creator);
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') return;
  assert.equal(res.card.reason, 'first-deploy');
  assert.equal(res.card.decision, 'pending');
  // The card carries scan + requested resources + footprint + diff.
  assert.equal(res.card.scan.passed, true);
  assert.ok(res.card.requested.footprint.estMonthlyUsd > 0);
  assert.ok(res.card.diff.files.length > 0);
  assert.equal(res.app.deploy.state, 'review');
});

test('GATE: a non-Builder CANNOT approve; a Builder can → live + envelope recorded', async () => {
  const app = await createApp(creator, { name: 'Renewals Tracker R2', template: 'nextjs-supabase' });
  const res = await requestDeploy(app.id, creator);
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') return;

  // Creator (participant) cannot approve their own deploy.
  await expectStatus(decideDeploy(res.card.id, creator, 'approve'), 403, /Builder|Administrator/);
  // A Builder from another domain cannot approve either.
  await expectStatus(decideDeploy(res.card.id, otherDomainBuilder, 'approve'), 403);

  // The domain Builder approves → live, envelope recorded for routine auto-deploy.
  const { app: live } = await decideDeploy(res.card.id, builder, 'approve');
  assert.equal(live.deploy.state, 'live');
  assert.ok(live.deploy.approved);
});

test('GATE: routine in-envelope update auto-deploys; scope-broadening re-reviews', async () => {
  const app = await createApp(creator, { name: 'Renewals Tracker R3', template: 'nextjs-supabase' });
  const r1 = await requestDeploy(app.id, creator);
  assert.equal(r1.kind, 'review');
  if (r1.kind !== 'review') return;
  await decideDeploy(r1.card.id, builder, 'approve');

  // No change → routine auto-deploy (no new card).
  const routine = await requestDeploy(app.id, creator);
  assert.equal(routine.kind, 'auto-deployed');

  // Consume a new connection → broadens scope → re-review.
  await consumeResource(app.id, creator, { kind: 'connection', ref: 'salesforce', label: 'Salesforce', scope: 'read' });
  const broadened = await requestDeploy(app.id, creator);
  assert.equal(broadened.kind, 'review');
  if (broadened.kind === 'review') assert.equal(broadened.card.reason, 'scope-broadened');
});

test('GATE: a committed secret fails the scan and BLOCKS approval (even routine)', async () => {
  const app = await createApp(creator, { name: 'Renewals Tracker R4', template: 'nextjs-supabase' });
  const r1 = await requestDeploy(app.id, creator);
  if (r1.kind === 'review') await decideDeploy(r1.card.id, builder, 'approve');

  // Commit a file with a hardcoded secret, then request a (routine) deploy.
  await commitToApp(app.id, creator, [{ path: 'leak.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' }], 'oops');
  const res = await requestDeploy(app.id, creator);
  // The clean routine path is refused; a review card is forced.
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') return;
  assert.equal(res.card.scan.passed, false);
  // Even a Builder cannot approve a failing scan.
  await expectStatus(decideDeploy(res.card.id, builder, 'approve'), 409, /scan did not pass/);
});

test('scopeBroadened: subset is routine, superset re-reviews', () => {
  const base = { writeTools: ['add'], connections: ['a'], data: [], knowledge: [], footprint: { cpu: '1', memory: '1', estMonthlyUsd: 5 } };
  assert.equal(scopeBroadened(base, { ...base }), false);
  assert.equal(scopeBroadened(base, { ...base, connections: ['a', 'b'] }), true);
  assert.equal(scopeBroadened(base, { ...base, footprint: { cpu: '1', memory: '1', estMonthlyUsd: 9 } }), true);
  assert.equal(scopeBroadened(null, base), true); // first deploy
});

test('globalThis pin: create survives a fresh cards() call', async () => {
  const app = await createApp(creator, { name: 'Pin Test App', template: 'nextjs-supabase' });
  const res = await requestDeploy(app.id, creator);
  assert.equal(res.kind, 'review');
  if (res.kind !== 'review') return;

  // Confirm card is visible via the globalThis symbol directly.
  const pinned = (globalThis as any)[Symbol.for('soa.software.review')] as Map<string, unknown>;
  assert.ok(pinned instanceof Map, 'globalThis pin is a Map');
  assert.ok(pinned.has(res.card.id), 'card id visible via globalThis pin');

  // getReviewCard() calls cards() afresh — must still return the card.
  const { getReviewCard } = await import('./review.ts');
  assert.ok(getReviewCard(res.card.id) !== null);
});
