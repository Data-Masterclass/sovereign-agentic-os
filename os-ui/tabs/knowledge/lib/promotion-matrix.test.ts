/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       knowledge
 * FEATURE:    The promotion matrix for "My knowledge" entries — the one ladder kind with no MCP door
 * USER STORY: As the owner I want "check also promotion of all other artifacts" to mean ALL of them,
 *             including the personal knowledge entries that only the UI route can create — so the
 *             kind that no agent can reach is held to the same rung-1 contract as the rest.
 * ARCHITECTURE:
 *   - The cross-kind file is `core/policy/promotion-matrix.test.ts`, which may import `@core/*`
 *     ONLY (CORE-INDEPENDENCE is counted per import statement and sits at its baseline).
 *     `personal_knowledge` has no MCP create tool and lives in `@tabs/knowledge/lib/personal-store`,
 *     so its row of the matrix has to live HERE — a tab test importing its own tab and the kernel,
 *     which is legal and costs the ratchet nothing.
 *   - Drives the real ladder seam (`@core/policy/ladder`) as creator / builder / domain_admin /
 *     admin, exactly as `app/api/knowledge/personal/[id]/promote/route.ts` does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { __resetApprovals, getApproval, listApprovals } from '@core/policy/approvals';
import { applyEffect } from '@core/policy/effects';
import { buildEffectDeps, fileArtifactPromotion, fileArtifactCertification } from '@core/policy/ladder';
import { canApprove } from '@core/policy/roles';
import { createPersonalKnowledge, getPersonalKnowledge } from '@tabs/knowledge/lib/personal-store';

const cara: CurrentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
const ben: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };
const dana: CurrentUser = { id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' };
const ada: CurrentUser = { id: 'ada', name: 'Ada', domains: ['sales'], role: 'admin' };
const dan: CurrentUser = { id: 'dan', name: 'Dan', domains: ['ops'], role: 'creator' };

const actor = (u: CurrentUser) => ({ id: u.id, role: u.role, domains: u.domains });
const principal = (u: CurrentUser) => ({ id: u.id, domains: u.domains, role: u.role });

async function refuses(fn: () => Promise<unknown>, re: RegExp, msg: string): Promise<void> {
  try {
    await fn();
    assert.fail(`${msg} — expected a refusal, got success`);
  } catch (e) {
    assert.match((e as Error).message, re, msg);
  }
}

test('personal_knowledge: a creator owner files rung 1 with approverRole=domain_admin, scope=domain', async () => {
  __resetApprovals();
  const rec = createPersonalKnowledge(principal(cara), { title: 'My note' });
  assert.equal(rec.visibility, 'Personal');

  const filed = await fileArtifactPromotion('personal_knowledge', rec.id, cara);
  assert.equal(filed.kind, 'artifact_promote');
  assert.equal(filed.payload.artifactKind, 'personal_knowledge');
  assert.equal(filed.approverRole, 'domain_admin');
  assert.equal(filed.scope, 'domain');
  assert.equal(filed.requestedBy, cara.id);
  // Idempotent.
  assert.equal((await fileArtifactPromotion('personal_knowledge', rec.id, cara)).id, filed.id);
  assert.equal(listApprovals({ status: 'pending' }).length, 1);
});

test('personal_knowledge: only the OWNER triggers, and a foreign domain learns nothing', async () => {
  __resetApprovals();
  const rec = createPersonalKnowledge(principal(cara), { title: 'Owner only' });
  await refuses(() => fileArtifactPromotion('personal_knowledge', rec.id, ben), /owner can request its promotion|[Nn]ot permitted|not found/, 'an in-domain builder is not the owner');
  await refuses(() => fileArtifactPromotion('personal_knowledge', rec.id, dan), /[Nn]ot permitted|not found|owner/, 'a foreign creator is refused');
});

test('personal_knowledge: a creator cannot approve; the domain admin flips the audience', async () => {
  __resetApprovals();
  const rec = createPersonalKnowledge(principal(cara), { title: 'Approve me' });
  const filed = await fileArtifactPromotion('personal_knowledge', rec.id, cara);

  assert.equal(canApprove(actor(cara), filed), false, 'the requester-creator cannot decide');
  assert.equal(canApprove(actor(ben), filed), false, 'a plain builder is below the rung-1 authority');
  assert.equal(canApprove(actor(dan), filed), false, 'a foreign creator cannot decide');
  assert.equal(canApprove(actor(dana), filed), true, 'the in-domain domain admin can');

  // The effect is the same seam the queue runs.
  const effect = await applyEffect(filed, actor(dana), buildEffectDeps());
  assert.equal(effect.ok, true, effect.applied);
  assert.equal(getPersonalKnowledge(rec.id, principal(cara)).visibility, 'Shared', 'the audience reached Domain');
  assert.equal(effect.audit.action, 'approve', 'and it carries an audit entry for the caller to write');
});

test('personal_knowledge: rung 2 is tenant-scoped and admin-only, and keeps four-eyes', async () => {
  __resetApprovals();
  const rec = createPersonalKnowledge(principal(cara), { title: 'Certify me' });
  const filed = await fileArtifactPromotion('personal_knowledge', rec.id, cara);
  await applyEffect(filed, actor(dana), buildEffectDeps());

  // A builder IN the domain vouches; a creator may not file rung 2 at all.
  await refuses(() => fileArtifactCertification('personal_knowledge', rec.id, cara), /Builder\/Domain-admin/, 'a creator cannot vouch for a domain asset');
  const cert = await fileArtifactCertification('personal_knowledge', rec.id, ben);
  assert.equal(cert.kind, 'promote_certify');
  assert.equal(cert.approverRole, 'admin');
  assert.equal(cert.scope, 'tenant');
  assert.equal(canApprove(actor(dana), cert), false, 'a domain admin cannot certify to Company');
  assert.equal(canApprove(actor(ben), cert), false, 'nor can the builder who filed it');

  const effect = await applyEffect(cert, actor(ada), buildEffectDeps());
  assert.equal(effect.ok, true, effect.applied);
  assert.equal(getPersonalKnowledge(rec.id, principal(cara)).visibility, 'Marketplace', 'the audience reached Company');

  // And the Company rung keeps four-eyes even for the admin who filed it.
  __resetApprovals();
  const second = createPersonalKnowledge(principal(cara), { title: 'Admin files it' });
  const f2 = await fileArtifactPromotion('personal_knowledge', second.id, cara);
  await applyEffect(f2, actor(dana), buildEffectDeps());
  const adaFiled = await fileArtifactCertification('personal_knowledge', second.id, ada);
  assert.equal(canApprove(actor(ada), adaFiled), false, 'a lone admin may not file AND certify company-wide');
  assert.equal(getApproval(adaFiled.id)!.status, 'pending');
});
