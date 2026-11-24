/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { isCompanyScope } from '@core/kernel/company-scope';
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import { roleAtLeast, canPromote } from '@core/kernel/session';
import { decide, enqueue, listApprovals, recordEffect, type Approval } from '@core/policy/approvals';
import { applyEffect, type EffectDeps, type EffectResult } from '@core/policy/effects';
import { record as auditRecord } from '@core/policy/audit';
import { publishPromotionLive } from '@tabs/data/lib/publish-server';
import { getWorkflow } from '@tabs/knowledge/lib/index';
import { getPersonalKnowledge, getPersonalKnowledgeForGovernance, decertifyPersonalKnowledge, unsharePersonalKnowledge } from '@tabs/knowledge/lib/personal-store';
import { freezeCertifiedKnowledgeBundle } from '@tabs/knowledge/lib/okf-freeze';
import { getDashboard, getDashboardForGovernance, demoteDashboard } from '@tabs/dashboards/lib/index';
import { getConnectionForUser, promoteConnection, demoteConnection, approveOnce } from '@tabs/connections/lib/index';
import { deleteSecret, getSecretServerSide } from '@core/infra/secrets';
import { approveExposureActions } from '@tabs/connections/lib/exposures';
import { getArtifact, promoteArtifact, demoteArtifact } from '@core/kernel/artifacts';
import { getAppForGovernance, getAppForUser, promoteApp } from '@tabs/software/lib/apps';
import { demoteApp } from '@tabs/software/lib/lifecycle';
import { decideDeploy } from '@tabs/software/lib/review';
import { getSystem, demoteSystem } from '@tabs/agents/lib/store';
import { appWriteApplier } from '@core/policy/app-write-port';

/**
 * THE UNIFIED PROMOTION / CERTIFICATION LADDER — the ONE filing + enforcement
 * point shared by BOTH the MCP tools and the UI routes (mcp-v2 P0.2). It closes
 * the governance back door where knowledge / connections / artifacts /
 * dashboards / apps used to promote DIRECTLY, bypassing the approval queue.
 *
 * Two canonical rungs (owner decision, do NOT relitigate):
 *   Rung 1 — Promotion (Personal→Domain): TRIGGER = the artifact OWNER only;
 *            APPROVE = a DOMAIN ADMIN of that domain. (This docstring used to say
 *            "a Builder+", which never matched either the gate or the queue: every
 *            rung-1 record is enqueued `approverRole: 'domain_admin'`, and
 *            `canPromote(role,'Personal')` is domain_admin+. A plain builder OWNS
 *            and PROPOSES; it does not decide.)
 *   Rung 2 — Certification (Domain→Marketplace): TRIGGER = a Builder/Domain-admin
 *            in the artifact's domain; APPROVE = a platform Admin.
 *
 * ONE PERSON MAY HOLD BOTH ROLES. When the owner is also the rung's approver — a
 * domain admin or the platform admin promoting their own artefact, the normal case on a
 * small tenant — they file and then decide it themselves. That is `canApprove`'s
 * audience-promotion carve-out (`core/policy/roles.ts`), and it is not a widening: rank
 * and scope are still checked, so a creator approves nothing and a domain admin certifies
 * nothing. Blanket four-eyes here bought no second pair of eyes; it made the artefact
 * unpromotable.
 *
 * The actual tier flip happens ONLY inside `effects.ts::applyEffect` (the effect
 * seam). This module never flips a tier itself — it files the governed request
 * (queue path) or, for the thin compat aliases + UI direct-promote buttons, runs
 * a one-shot decision THROUGH the same seam (`promoteThroughSeam`). Either way,
 * no bytes move outside `effects.ts`.
 */

/** The formerly-DIRECT ladder kinds this module governs (dataset/file keep their
 *  own already-two-step rails in write-tools). */
export type LadderKind = 'knowledge' | 'personal_knowledge' | 'connection' | 'artifact' | 'dashboard' | 'app' | 'agent_system';
export const LADDER_KINDS: readonly LadderKind[] = ['knowledge', 'personal_knowledge', 'connection', 'artifact', 'dashboard', 'app', 'agent_system'] as const;
/**
 * The `kind` word a caller (an MCP tool, an agent) used → the ladder kind it means, decided by the id.
 * A workflow (`wf_…`) is ladder kind `knowledge` — a historical, PERSISTED spelling (approvals and
 * promotion records already carry it, so it is not renamed); a knowledge note (`pk_…`) is
 * `personal_knowledge`. So callers may say `workflow` (the real name), and `knowledge` with a note id
 * means the note — the mix-up this prevents is a note promoted through the workflow path and back.
 */
export function normalizeLadderKind(kind: string, id: string): string {
  const k = kind.trim();
  if (k === 'workflow') return 'knowledge';
  if (k === 'knowledge' && id.trim().startsWith('pk_')) return 'personal_knowledge';
  return k;
}

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
export async function resolveLadderArtifact(
  kind: LadderKind,
  id: string,
  user: CurrentUser,
  opts: { forGovernanceAct?: boolean } = {},
): Promise<Resolved> {
  const p = { id: user.id, domains: user.domains, role: user.role };
  const forGovernanceAct = opts.forGovernanceAct === true;
  switch (kind) {
    case 'knowledge': {
      const w = getWorkflow(id, p); // throws 403/404 when unseeable
      return { owner: w.owner, domain: w.domain, name: w.title, visibility: w.visibility };
    }
    case 'personal_knowledge': {
      // Plain view gate by default (a Personal entry is owner-only, and stays so); the widened
      // governance read only for the approve-half — the same opt-in as `dashboard`.
      const e = forGovernanceAct ? getPersonalKnowledgeForGovernance(id, p) : getPersonalKnowledge(id, p);
      return { owner: e.owner, domain: e.domain, name: e.title, visibility: e.visibility };
    }
    case 'dashboard': {
      // The PLAIN view gate by default — a Personal dashboard stays owner-only here, so
      // resolving one is not a way for a domain admin to read its name. The widened
      // governance read is reached ONLY through `opts.forGovernanceAct`, which the two call
      // sites that genuinely need it pass: the approve-half of a request the owner filed
      // (`promoteThroughSeam`) and the effect's own `transitionDashboard`.
      const d = forGovernanceAct ? getDashboardForGovernance(id, p) : getDashboard(id, p); // throws 403/404
      return { owner: d.owner, domain: d.domain, name: d.spec.name, visibility: d.tier };
    }
    case 'connection': {
      const c = await getConnectionForUser(id, user); // throws 403/404
      return { owner: c.owner, domain: c.domain, name: c.name, visibility: c.visibility };
    }

    case 'artifact': {
      const a = await getArtifact(id);
      if (!a) fail('Artifact not found', 404);
      const canSee = a.owner === user.id || user.role === 'admin' || isCompanyScope(a.visibility) || (a.visibility !== 'Personal' && user.domains.includes(a.domain));
      if (!canSee) fail('Artifact not found', 404);
      return { owner: a.owner, domain: a.domain, name: a.name, visibility: a.visibility };
    }
    case 'app': {
      // The governance read is reached ONLY through `opts.forGovernanceAct`, so an appointed
      // approver can see the Personal app whose promotion they were asked to decide.
      const app = forGovernanceAct ? await getAppForGovernance(id, user) : await getAppForUser(id, user);
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
  const asCurrentUser = (a: { id: string; role: CurrentUser['role']; domains: string[] }): CurrentUser => ({ id: a.id, name: a.id, domains: a.domains, allDomains: a.domains, activeDomain: null, role: a.role });
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
    decideDeploy: async (cardId, approver, decision) => {
      const { app } = await decideDeploy(cardId, asCurrentUser(approver), decision);
      return { appName: app.name, state: app.deploy.state, live: Boolean(app.deploy.previewUrl) };
    },
    enableExposureActions: (exposureId, approver) => approveExposureActions(exposureId, asCurrentUser(approver)),
    freezeKnowledgeBundle: (workflowId, approver) => freezeCertifiedKnowledgeBundle(workflowId, { id: approver.id, role: approver.role, domains: approver.domains }),
    // Read at call time: the Software tab registers it at boot (`instrumentation.ts`).
    applyAppWrite: async (req) => {
      const run = appWriteApplier();
      return run ? run(req) : { ok: false, reason: 'no app-write runner is registered in this OS process; nothing was written' };
    },
    applyConnectionWrite: async (payload, approver) => {
      // EXECUTE the held write through the governed approveOnce seam AS the approver — the
      // capability profile / four-layer intersection is re-checked inside, so a doctored
      // payload can never widen the write. Map the ToolCallResult to an honest {ok, reason}.
      // The card's arguments are REDACTED when they held a secret; the real ones are in the vault.
      // Gone (another process, a restart) ⇒ an honest failure, never a run with redacted values.
      let args = payload.args;
      if (payload.argsRef) {
        const raw = getSecretServerSide(payload.argsRef);
        if (raw === null) return { ok: false, reason: 'the held write\'s arguments are no longer available on this server — ask the requester to run it again' };
        try {
          args = JSON.parse(raw) as Record<string, unknown>;
        } catch (e) {
          return { ok: false, reason: `the held write's vaulted arguments could not be read: ${(e as Error).message}` };
        }
      }
      const res = await approveOnce(payload.connId, asCurrentUser(approver), { tool: payload.tool, args, requestedBy: payload.requestedBy });
      if (payload.argsRef) deleteSecret(payload.argsRef);
      const ok = res.decision === 'allow';
      const execFailed = ok && (res.result as { ok?: boolean } | undefined)?.ok === false;
      const reason = execFailed
        ? `executor reported failure: ${((res.result as { reason?: string }).reason) ?? 'no reason given'}`
        : res.reason;
      return { ok: ok && !execFailed, reason, ...(res.attribution ? { attribution: { ...res.attribution } } : {}) };
    },
  };
}

/**
 * The thin-compat + UI one-shot: advance a ladder artifact one rung THROUGH the
 * effect seam in a single call. This is the "approve half" the retained aliases
 * (`publish_workflow`, `promote_connection`, software `promote`) and the
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
): Promise<
  | { requested: true; approval: Approval; hint: string; rung: 'certify'; artifact: Resolved }
  | (EffectResult & { requested?: false; rung: 'promote' | 'certify'; artifact: Resolved })
> {
  // `forGovernanceAct`: this entry IS the approve-half (the ladder's own one-shot and the
  // re-pointed UI promote buttons), so the appointed approver may read what they are deciding.
  // Filing (`fileArtifactPromotion`) and certification-filing deliberately do NOT pass it.
  const art = await resolveLadderArtifact(kind, id, user, { forGovernanceAct: true });
  const tier = normVisibility(art.visibility);
  if (tier === 'Marketplace') fail(`This ${kind} is already certified`, 409);
  const rung: 'promote' | 'certify' = tier === 'Personal' ? 'promote' : 'certify';
  // Intent guard: never let a tier-derived rung diverge from the caller's stated one.
  if (opts.rung && opts.rung !== rung) {
    fail(`Cannot ${opts.rung} a ${tier} ${kind} — its next rung is ${rung}. Refuse rather than silently ${rung}.`, 409);
  }

  // SEPARATION OF DUTIES, ON BOTH RUNGS.
  //
  // Rung 1 (My→Domain): the owner one-shots — that is the carve-out `canApprove` grants, because
  // a rung-1 request is owner-only to file, so refusing the owner-approver would only strand the
  // artefact. A NON-owner may act here solely as the APPROVE-half of a request the owner filed.
  //
  // Rung 2 (Domain→COMPANY): the owner must NOT one-shot. This check used to read rung 1 only, so
  // an admin who OWNED a Shared artefact and called the tab's own promote entry (publish_workflow,
  // promote_connection, the software `promote`, a UI promote button — none of which name a rung,
  // so the rung is derived from the tier) certified it company-wide in a single call, and minted a
  // `promote_certify` record with `decidedBy === requestedBy`: exactly the act the Governance door
  // refuses. Company scope is the whole tenant and rung 2 is normally filed by a Builder or
  // Domain-admin of the domain, so there IS somebody else to ask. File (or reuse) the request and
  // say so, rather than quietly performing both halves.
  let realPending: Approval | null = null;
  if (art.owner !== user.id) {
    if (rung === 'promote') {
      realPending = existingPending('artifact_promote', kind, id);
      if (!realPending) {
        fail(`Only the ${kind} owner can promote it directly — the owner must file request_promotion first, then a domain admin approves it.`, 403);
      }
    }
  } else if (rung === 'certify') {
    const pending = existingPending('promote_certify', kind, id) ?? (await fileArtifactCertification(kind, id, user, opts));
    return {
      requested: true,
      approval: pending,
      hint: 'Certification to Company needs a second Admin — you filed this request, so you cannot also decide it.',
      rung: 'certify',
      artifact: art,
    };
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

  // THE ONE-SHOT MUST LEAVE THE SAME TRACE AS A DECISION. `applyEffect` returns the audit entry
  // it wants written; the queue path writes it, and this path used to DROP it — so an audience
  // move made by an owner-approver (or by one of the UI direct-promote buttons) appeared in no
  // audit log and in no Governance queue. An un-recorded promotion is invisible to exactly the
  // people the queue exists for, which is worse than a noisy one.
  if (effect.ok) {
    if (realPending) {
      // It satisfied a request somebody really filed: close that record out.
      decide(realPending.id, 'approve', user.id);
      recordEffect(realPending.id, { applied: effect.applied, live: effect.live, publish: effect.publish });
    } else {
      // Nobody filed one, so MINT the record and self-approve it, with `source: 'ladder'` and
      // `decidedBy` saying who did it. The inbox then shows what happened and by whom.
      const minted = enqueue({
        kind: synthetic.kind,
        title: synthetic.title,
        detail: synthetic.detail,
        agent: user.id,
        domain: art.domain,
        requestedBy: user.id,
        tool: synthetic.tool,
        payload: synthetic.payload,
        approverRole: synthetic.approverRole,
        scope: synthetic.scope,
        source: 'ladder',
      });
      decide(minted.id, 'approve', user.id);
      recordEffect(minted.id, { applied: effect.applied, live: effect.live, publish: effect.publish });
    }
    auditRecord({
      actor: user.id,
      action: effect.audit.action,
      subject: effect.audit.subject,
      domain: art.domain,
      reason: effect.audit.reason,
      detail: { ...effect.audit.detail, oneShot: true, rung },
    });
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
  const out = await promoteThroughSeam(kind, id, user);
  // `promoteThroughSeam` can itself answer "filed" now — the owner of a SHARED artefact asking to
  // certify it. Forward that, rather than labelling it `requested: false`.
  if (out.requested) return { requested: true, approval: out.approval };
  return { requested: false, ...out };
}

/** The ladder kinds a DEMOTE (revoke sharing) is wired for — the reverse of the
 *  UI direct-promote buttons. dataset/file keep their own lifecycle/transition rails. */
export type DemotableKind = Extract<LadderKind, 'artifact' | 'app' | 'connection' | 'personal_knowledge' | 'agent_system' | 'dashboard'>;
const DEMOTABLE: readonly DemotableKind[] = ['artifact', 'app', 'connection', 'personal_knowledge', 'agent_system', 'dashboard'] as const;
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
    case 'dashboard': {
      const d = demoteDashboard(id, p);
      result = { id: d.id, name: d.spec.name, visibility: d.tier };
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
