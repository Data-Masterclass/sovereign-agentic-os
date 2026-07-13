/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Demote (revoke sharing) SEAM tests — the reverse of the promote ladder, proven
 * end-to-end through `demoteThroughSeam`: the rung is derived from the artifact's
 * current tier, the per-kind role gate is enforced (fail-closed), and EVERY demote
 * emits ONE audit entry (mirrors how promotion is audited).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Offline: any OpenSearch/live probe fails fast so stores init in-process.
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

const { demoteThroughSeam, isDemotableKind } = await import('./ladder.ts');
const { search: auditSearch, __resetAudit } = await import('./audit.ts');
const { createArtifact, promoteArtifact, getArtifact, __resetArtifactsCache } = await import('../core/artifacts.ts');
import type { CurrentUser } from '../core/auth.ts';

const admin: CurrentUser = { id: 'arya', name: 'Arya', domains: ['sales'], role: 'admin' };
const builder: CurrentUser = { id: 'sara', name: 'Sara', domains: ['sales'], role: 'builder' };
// Promoting Personal→Shared now requires domain_admin+; `domainAdmin` is the in-domain approver.
const domainAdmin: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };
const creator: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };

beforeEach(() => {
  __resetArtifactsCache();
  __resetAudit();
});

test('the demotable-kind guard names exactly the five ladder kinds', () => {
  for (const k of ['artifact', 'app', 'connection', 'personal_knowledge', 'agent_system']) {
    assert.equal(isDemotableKind(k), true);
  }
  assert.equal(isDemotableKind('dataset'), false); // data has its own lifecycle route
});

test('SEAM: demote derives the rung from the tier and lowers Certified → Shared → Personal', async () => {
  const a = await createArtifact(admin, { type: 'metric', name: 'Revenue', domain: 'sales' });
  await promoteArtifact(a.id, admin); // → Shared
  await promoteArtifact(a.id, admin); // → Certified

  const d1 = await demoteThroughSeam('artifact', a.id, admin);
  assert.equal(d1.rung, 'decertify');
  assert.equal(d1.result.visibility, 'Shared');

  const d2 = await demoteThroughSeam('artifact', a.id, admin);
  assert.equal(d2.rung, 'unshare');
  assert.equal(d2.result.visibility, 'Personal');
  assert.equal((await getArtifact(a.id))!.visibility, 'Personal');
});

test('SEAM role gate (fail-closed): a creator cannot demote a Certified artifact they do not own', async () => {
  const a = await createArtifact(admin, { type: 'metric', name: 'Guarded', domain: 'sales' });
  await promoteArtifact(a.id, admin);
  await promoteArtifact(a.id, admin); // Certified
  await assert.rejects(
    () => demoteThroughSeam('artifact', a.id, creator),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 403);
      return true;
    },
  );
});

test('SEAM intent guard: asking to unshare a Certified artifact is refused (no silent decertify)', async () => {
  const a = await createArtifact(admin, { type: 'metric', name: 'Intent', domain: 'sales' });
  await promoteArtifact(a.id, admin);
  await promoteArtifact(a.id, admin); // Certified
  await assert.rejects(() => demoteThroughSeam('artifact', a.id, admin, { rung: 'unshare' }), /next revoke step is decertify/);
});

test('SEAM: every demote emits exactly one audit entry naming the revoke rung', async () => {
  const a = await createArtifact(builder, { type: 'knowledge', name: 'Runbook', domain: 'sales' });
  await promoteArtifact(a.id, domainAdmin); // → Shared (owned by builder)
  __resetAudit();
  await demoteThroughSeam('artifact', a.id, builder); // Shared → Personal
  const entries = auditSearch({ q: 'revoke sharing' });
  assert.equal(entries.length, 1, 'one audit entry per demote');
  assert.equal(entries[0].actor, builder.id);
  assert.equal(entries[0].detail.rung, 'unshare');
  assert.equal(entries[0].detail.to, 'Personal');
});
