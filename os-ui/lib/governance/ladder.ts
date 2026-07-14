/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast, canPromote } from '@/lib/core/session';
import { decide, enqueue, listApprovals, recordEffect, type Approval } from '@/lib/governance/approvals';
import { applyEffect, type EffectDeps, type EffectResult } from '@/lib/governance/effects';
import { record as auditRecord } from '@/lib/governance/audit';
import { publishPromotionLive } from '@/lib/data/publish-server';
import { getWorkflow } from '@/lib/knowledge/store';
import { getPersonalKnowledge, decertifyPersonalKnowledge, unsharePersonalKnowledge } from '@/lib/knowledge/personal-store';
import { getDashboard } from '@/lib/dashboards/store';
import { getConnectionForUser, promoteConnection, demoteConnection } from '@/lib/connections';
import { getModel } from '@/lib/science/model-service';
import { getArtifact, promoteArtifact, demoteArtifact } from '@/lib/core/artifacts';
import { getAppForUser, promoteApp } from '@/lib/software/apps';
import { demoteApp } from '@/lib/software/lifecycle';
import { getSystem, demoteSystem } from '@/lib/agents/store';

/**
 * THE UNIFIED PROMOTION / CERTIFICATION LADDER — the ONE filing + enforcement
 * point shared by BOTH the MCP tools and the UI routes (mcp-v2 P0.2). It closes
 * the governance back door where knowledge / connections / models / artifacts /
 * dashboards / apps used to promote DIRECTLY, bypassing the approval queue.
 *
 * Two canonical rungs (owner decision, do NOT relitigate):
 *   Rung 1 — Promotion (Personal→Domain): TRIGGER = the artifact OWNER only;
 *            APPROVE = a Builder+ of that domain.
 *   Rung 2 — Certification (Domain→Marketplace): TRIGGER = a Builder/Domain-admin
 *            in the artifact's domain; APPROVE = a platform Admin.
 *
 * The actual tier flip happens ONLY inside `effects.ts::applyEffect` (the effect
 * seam). This module never flips a tier itself — it files the governed request
 * (queue path) or, for the thin compat aliases + UI direct-promote buttons, runs
 * a one-shot decision THROUGH the same seam (`promoteThroughSeam`). Either way,
 * no bytes move outside `effects.ts`.
 */

/** The formerly-DIRECT ladder kinds this module governs (dataset/file keep their
 *  own already-two-step rails in write-tools). */
export type LadderKind = 'knowledge' | 'personal_knowledge' | 'connection' | 'model' | 'artifact' | 'dashboard' | 'app' | 'agent_system';
export const LADDER_KINDS: readonly LadderKind[] = ['knowledge', 'personal_knowledge', 'connection', 'model', 'artifact', 'dashboard', 'app', 'agent_system'] as const;
export function isLadderKind(x: string): x is LadderKind {
  return (LADDER_KINDS as readonly string[]).includes(x);
}

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

type Resolved = { owner: string; domain: string; name: string; visibility: string };

/** The current tier/visibility label, normalised to Personal | Shared | Marketplace. */
function normVisibility(v: string): 'Personal' | 'Shared' | 'Marketplace' {
  const s = v.toLowerCase();
  if (s === 'personal' || s === 'dataset' || s === 'draft') return 'Personal';
  if (s === 'marketplace' || s === 'certified' || s === 'product') return 'Marketplace';
  return 'Shared';
}

/**
 * Resolve an artifact to {owner, domain, name, visibility}, ENFORCING that the
 * caller may at least see it (an unseeable id is a uniform not_found — no
 * existence leak). Reuses each tab's own governed getter where it scope-checks.
 */
export async function resolveLadderArtifact(kind: LadderKind, id: string, user: CurrentUser): Promise<Resolved> {
  const p = { id: user.id, domains: user.domains, role: user.role };
  switch (kind) {
    case 'knowledge': {
      const w = getWorkflow(id, p); // throws 403/404 when unseeable
      return { owner: w.owner, domain: w.domain, name: w.title, visibility: w.visibility };
    }
    case 'personal_knowledge': {
      const e = getPersonalKnowledge(id, p); // throws 403/404 when unseeable
      return { owner: e.owner, domain: e.domain, name: e.title, visibility: e.visibility };
    }
    case 'dashboard': {
      const d = getDashboard(id, p); // throws 403/404
      return { owner: d.owner, domain: d.domain, name: d.spec.name, visibility: d.tier };
    }
    case 'connection': {
      const c = await getConnectionForUser(id, user); // throws 403/404
      return { owner: c.owner, domain: c.domain, name: c.name, visibility: c.visibility };
    }
    case 'model': {
      const m = getModel(id);
      if (!m) fail('Model not found', 404);
      // getModel is unscoped — enforce visibility here (owner, or in-domain for
      // Domain+ tiers, or admin) so a forged id cannot leak another's Personal model.
      const canSee = m.owner === user.id || user.role === 'admin' || (m.tier !== 'Personal' && user.domains.includes(m.domain));
      if (!canSee) fail('Model not found', 404);
      return { owner: m.owner, domain: m.domain, name: m.name, visibility: m.tier };
    }
    case 'artifact': {
      const a = await getArtifact(id);
      if (!a) fail('Artifact not found', 404);
      const canSee = a.owner === user.id || user.role === 'admin' || (a.visibility !== 'Personal' && user.domains.includes(a.domain));
      if (!canSee) fail('Artifact not found', 404);
      return { owner: a.owner, domain: a.domain, name: a.name, visibility: a.visibility };
    }
    case 'app': {
      const app = await getAppForUser(id, user); // throws 403/404
      return { owner: app.owner, domain: app.domain, name: app.name, visibility: app.visibility };
    }
    case 'agent_system': {
      const s = getSystem(id, user); // throws 403/404
      return { owner: s.owner, domain: s.domain, name: s.name, visibility: s.visibility };
    }
    default:
      fail(`Unknown ladder kind ${kind}`, 400);
  }
}

/** Return the existing pending ladder request for this (kind,id,rung), or null. */
function existingPending(approvalKind: Approval['kind'], artifactKind: LadderKind, id: string): Approval | null {
  return (
    listApprovals({ status: 'pending' }).find(
      (a) => a.kind === approvalKind && a.payload?.artifactKind === artifactKind && a.payload?.id === id,
    ) ?? null
  );
}

/**
 * RUNG 1 — FILE a promotion (Personal→Domain). Owner-only trigger: edit rights are
 * NOT enough. Returns the enqueued (or already-pending) governed request. Does NOT
 * flip anything — a Builder+ of the domain applies it via `decide_approval`.
 */
export async function fileArtifactPromotion(kind: LadderKind, id: string, user: CurrentUser): Promise<Approval> {
  const art = await resolveLadderArtifact(kind, id, user);
  if (art.owner !== user.id) fail(`Only the ${kind} owner can request its promotion`, 403);
  if (normVisibility(art.visibility) !== 'Personal') fail(`This ${kind} is already promoted`, 409);
  const dup = existingPending('artifact_promote', kind, id);
  if (dup) return dup;
  return enqueue({
    kind: 'artifact_promote',
    title: `Promote “${art.name}” to a ${art.domain} domain ${kind}`,
    detail: `${user.id} requests promoting the ${kind} “${art.name}” to a shared domain asset. A domain admin must approve.`,
    agent: user.id,
    domain: art.domain,
    requestedBy: user.id,
    tool: `${kind}_promote`,
    payload: { artifactKind: kind, id, name: art.name },
    approverRole: 'domain_admin',
    scope: 'domain',
  });
}

/**
 * RUNG 2 — FILE a certification (Domain→Marketplace). The domain vouches: a
 * Builder/Domain-admin IN the artifact's domain files; a platform Admin approves.
 */
export async function fileArtifactCertification(
  kind: LadderKind,
  id: string,
  user: CurrentUser,
  opts: { mode?: string } = {},
): Promise<Approval> {
  const art = await resolveLadderArtifact(kind, id, user);
  const inDomain = user.domains.includes(art.domain);
  if (!(roleAtLeast(user.role, 'builder') && inDomain)) {
    fail(`Certification is filed by a Builder/Domain-admin in the ${kind}'s domain (${art.domain})`, 403);
  }
  if (normVisibility(art.visibility) !== 'Shared') {
    fail(normVisibility(art.visibility) === 'Marketplace' ? `This ${kind} is already certified` : `Promote this ${kind} to the domain before certifying`, 409);
  }
  const dup = existingPending('promote_certify', kind, id);
  if (dup) return dup;
  return enqueue({
    kind: 'promote_certify',
    title: `Certify “${art.name}” to the marketplace`,
    detail: `${user.id} (${art.domain}) requests certifying the ${kind} “${art.name}” to the cross-domain marketplace. A platform Admin must approve.`,
    agent: user.id,
    domain: art.domain,
    requestedBy: user.id,
    tool: `${kind}_certify`,
    payload: { artifactKind: kind, id, name: art.name, ...(opts.mode ? { mode: opts.mode } : {}) },
    approverRole: 'admin',
    scope: 'tenant',
  });
}

/** The full injected effect-dep bundle (the ONE place server callers wire the
 *  physical publisher + the async ladder appliers into `applyEffect`). */
export function buildEffectDeps(): EffectDeps {
  const asCurrentUser = (a: { id: string; role: CurrentUser['role']; domains: string[] }): CurrentUser => ({ id: a.id, name: a.id, domains: a.domains, role: a.role });
  return {
    publishPromotion: publishPromotionLive,
    promoteConnection: async (id, approver) => {
      const c = await promoteConnection(id, asCurrentUser(approver));
      return { id: c.id, name: c.name, visibility: c.visibility };
    },
    promoteArtifact: async (id, approver) => {
      const a = await promoteArtifact(id, asCurrentUser(approver));
      return { id: a.id, name: a.name, visibility: a.visibility };
    },
    promoteApp: async (id, approver) => {
      const app = await promoteApp(id, asCurrentUser(approver));
      return { id: app.id, name: app.name, visibility: app.visibility };
    },
  };
}

/**
 * The thin-compat + UI one-shot: advance a ladder artifact one rung THROUGH the
 * effect seam in a single call. This is the "approve half" the retained aliases
 * (`publish_knowledge`, `promote_connection`, software `promote`) and the
 * re-pointed UI direct-promote buttons collapse onto — same privilege as the old
 * direct fns (the underlying store re-gates role+domain), but NO tier flips
 * outside `effects.ts`.
 *
 * SEPARATION-OF-DUTIES is enforced even on this one-shot path (mcp-v2 review):
 *   • Rung 1 (promote): the caller must BE the owner, OR a rung-1 request must
 *     already be pending (which this call then decides as the approve-half). A
 *     non-owner with NO filed request is refused — a builder can never publish a
 *     creator's PRIVATE draft without the owner's filing (knowledge canEdit would
 *     otherwise allow it).
 *   • The rung is asserted against the caller's INTENT when given (`opts.rung`):
 *     a mismatch (e.g. an admin's "promote" on a Shared asset that would silently
 *     certify) is a typed conflict, never a silent tier jump.
 */
export async function promoteThroughSeam(
  kind: LadderKind,
  id: string,
  user: CurrentUser,
  opts: { mode?: string; rung?: 'promote' | 'certify' } = {},
): Promise<EffectResult & { rung: 'promote' | 'certify'; artifact: Resolved }> {
  const art = await resolveLadderArtifact(kind, id, user);
  const tier = normVisibility(art.visibility);
  if (tier === 'Marketplace') fail(`This ${kind} is already certified`, 409);
  const rung: 'promote' | 'certify' = tier === 'Personal' ? 'promote' : 'certify';
  // Intent guard: never let a tier-derived rung diverge from the caller's stated one.
  if (opts.rung && opts.rung !== rung) {
    fail(`Cannot ${opts.rung} a ${tier} ${kind} — its next rung is ${rung}. Refuse rather than silently ${rung}.`, 409);
  }

  // Separation-of-duties on rung 1: owner one-shots; a non-owner may only act as
  // the APPROVE-half of a request the owner already filed.
  let realPending: Approval | null = null;
  if (rung === 'promote' && art.owner !== user.id) {
    realPending = existingPending('artifact_promote', kind, id);
    if (!realPending) {
      fail(`Only the ${kind} owner can promote it directly — the owner must file request_promotion first, then a Builder approves it.`, 403);
    }
  }

  const synthetic: Approval = {
    id: realPending?.id ?? `inline_${Date.now().toString(36)}`,
    kind: rung === 'promote' ? 'artifact_promote' : 'promote_certify',
    title: `${rung} ${art.name}`,
    detail: `Inline ${rung} of ${kind} ${id} by ${user.id}`,
    agent: user.id,
    domain: art.domain,
    requestedBy: realPending?.requestedBy ?? user.id,
    tool: `${kind}_${rung}`,
    payload: { artifactKind: kind, id, name: art.name, ...(opts.mode ? { mode: opts.mode } : {}) },
    approverRole: rung === 'certify' ? 'admin' : 'domain_admin',
    scope: rung === 'certify' ? 'tenant' : 'domain',
    rememberable: false,
    source: 'ladder',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  const effect = await applyEffect(synthetic, { id: user.id, role: user.role, domains: user.domains }, buildEffectDeps());
  // If this satisfied a real filed request, close it out so it doesn't linger.
  if (realPending && effect.ok) {
    decide(realPending.id, 'approve', user.id);
    recordEffect(realPending.id, { applied: effect.applied, live: effect.live, publish: effect.publish });
  }
  return { ...effect, rung, artifact: art };
}

/**
 * PROMOTE-OR-PROPOSE — the one entry the UI "Promote to Shared" button should call
 * so promotion is CONSISTENT across every tab. Personal→Shared:
 *   • an OWNER who lacks approver authority (creator/builder) FILES a request
 *     (`fileArtifactPromotion`) → it lands in Governance for a domain_admin+ to
 *     approve — NO more "requires a Domain admin" dead-end.
 *   • an approver (domain_admin+) promotes in one shot through the seam.
 * Shared→Certified and the non-owner-with-no-request case fall through to
 * `promoteThroughSeam` unchanged (SoD preserved). Returns a discriminated result so
 * the route can tell the UI "requested" vs "promoted".
 */
export async function promoteOrRequest(
  kind: LadderKind,
  id: string,
  user: CurrentUser,
): Promise<
  | { requested: true; approval: Approval }
  | ({ requested: false } & EffectResult & { rung: 'promote' | 'certify'; artifact: Resolved })
> {
  const art = await resolveLadderArtifact(kind, id, user);
  if (normVisibility(art.visibility) === 'Personal' && art.owner === user.id && !canPromote(user.role, 'Personal')) {
    return { requested: true, approval: await fileArtifactPromotion(kind, id, user) };
  }
  return { requested: false, ...(await promoteThroughSeam(kind, id, user)) };
}

/** The ladder kinds a DEMOTE (revoke sharing) is wired for — the reverse of the
 *  UI direct-promote buttons. dataset/file keep their own lifecycle/transition rails. */
export type DemotableKind = Extract<LadderKind, 'artifact' | 'app' | 'connection' | 'personal_knowledge' | 'agent_system'>;
const DEMOTABLE: readonly DemotableKind[] = ['artifact', 'app', 'connection', 'personal_knowledge', 'agent_system'] as const;
export function isDemotableKind(x: string): x is DemotableKind {
  return (DEMOTABLE as readonly string[]).includes(x);
}

/** The applied summary a per-kind demote returns (id + new visibility). */
type Demoted = { id: string; name: string; visibility: string };

/**
 * REVOKE SHARING — walk a ladder artifact ONE rung DOWN, the mirror of
 * `promoteThroughSeam`:
 *   Certified/Marketplace ──(Admin)──▶ Shared ──(owner | in-domain Builder+)──▶ Personal
 *
 * The rung is derived from the artifact's CURRENT tier (never a silent jump). Each
 * per-kind store fn is the primary role gate (fail-closed: a creator who is not the
 * owner cannot unshare a shared/certified asset; only an Admin can revoke from the
 * marketplace) and, where relevant (apps), the lineage guard that refuses to orphan
 * a live consumer. This seam adds the intent guard + a single audit entry, exactly
 * mirroring how promotion is audited. It NEVER deletes the underlying asset.
 */
export async function demoteThroughSeam(
  kind: DemotableKind,
  id: string,
  user: CurrentUser,
  opts: { rung?: 'decertify' | 'unshare' } = {},
): Promise<{ rung: 'decertify' | 'unshare'; artifact: Resolved; result: Demoted }> {
  const art = await resolveLadderArtifact(kind, id, user); // view gate + current tier
  const tier = normVisibility(art.visibility);
  if (tier === 'Personal') fail(`This ${kind} is already personal — nothing to revoke`, 409);
  const rung: 'decertify' | 'unshare' = tier === 'Marketplace' ? 'decertify' : 'unshare';
  // Intent guard: never let a tier-derived rung diverge from the caller's stated one.
  if (opts.rung && opts.rung !== rung) {
    fail(`Cannot ${opts.rung} a ${tier} ${kind} — its next revoke step is ${rung}.`, 409);
  }

  const p = { id: user.id, domains: user.domains, role: user.role };
  let result: Demoted;
  switch (kind) {
    case 'artifact': {
      const a = await demoteArtifact(id, user);
      result = { id: a.id, name: a.name, visibility: a.visibility };
      break;
    }
    case 'connection': {
      const c = await demoteConnection(id, user);
      result = { id: c.id, name: c.name, visibility: c.visibility };
      break;
    }
    case 'app': {
      const a = await demoteApp(id, user);
      result = { id: a.id, name: a.name, visibility: a.visibility };
      break;
    }
    case 'personal_knowledge': {
      const rec = rung === 'decertify' ? decertifyPersonalKnowledge(id, p) : unsharePersonalKnowledge(id, p);
      result = { id: rec.id, name: rec.title, visibility: rec.visibility };
      break;
    }
    case 'agent_system': {
      const rec = demoteSystem(id, p);
      result = { id: rec.id, name: rec.name, visibility: rec.visibility };
      break;
    }
    default:
      fail(`Unknown demotable kind ${kind}`, 400);
  }

  auditRecord({
    actor: user.id,
    action: 'approve',
    subject: result.name,
    domain: art.domain,
    reason: `${kind} ${rung} (revoke sharing) by ${user.id}`,
    detail: { artifactKind: kind, id, rung, from: tier, to: result.visibility },
  });
  return { rung, artifact: art, result };
}
