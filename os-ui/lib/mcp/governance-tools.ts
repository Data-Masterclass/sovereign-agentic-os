/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool } from './server';
import { pendingHandle, whoCanApprove } from './pending';
import { decide, getApproval, listApprovals, recordEffect, type Approval, type ApprovalStatus, type ApprovalKind } from '@/lib/approvals';
import { canApprove, canSee, roleLabel } from '@/lib/governance/roles';
import { applyEffect } from '@/lib/governance/effects';
import { buildEffectDeps, fileArtifactCertification, isLadderKind, type LadderKind } from '@/lib/governance/ladder';
import { remember } from '@/lib/governance/standing';
import { record as audit } from '@/lib/governance/audit';
import { getLineage } from '@/lib/lineage/unified';
import { importAdapter } from '@/lib/marketplace';
import type { ImportMode } from '@/lib/marketplace/types';
import { canViewPolicyPlane, consolidatedPlane, listEgress, policySources } from '@/lib/governance/policy-view';
import { listStanding } from '@/lib/governance/standing';
import { listCaps, checkCap } from '@/lib/governance/cost';
import { listUsers } from '@/lib/users';
import { roleAtLeast } from '@/lib/core/session';

/**
 * THE GOVERNANCE QUEUE + LADDER META-TOOLS (mcp-v2 P0). These wrap the EXISTING
 * approvals + roles + effects libs — no new store, no second governance path. They
 * turn every gated golden path into an agent-completable loop:
 *   • a creator files (request_promotion / request_certification / import_product);
 *   • they poll `get_request`;
 *   • a decider works `list_approvals` → `decide_approval` (the approval IS the action).
 *
 * Identity comes from the SESSION only; every gate re-checks rank-aware canSee /
 * canApprove against the live 4-rank model.
 */

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The caller as a governance Actor (id + domains + role). */
function actor(u: CurrentUser) {
  return { id: u.id, domains: u.domains, role: u.role };
}

/** A wire-safe view of an approval (no internal payload leak beyond the summary). */
function requestView(a: Approval, u: CurrentUser) {
  return {
    requestId: a.id,
    kind: a.kind,
    title: a.title,
    status: a.status,
    domain: a.domain,
    requestedBy: a.requestedBy,
    approverRole: a.approverRole,
    scope: a.scope,
    whoCanApprove: whoCanApprove(a),
    mayApprove: canApprove(actor(u), a),
    decidedBy: a.decidedBy ?? null,
    decidedAt: a.decidedAt ?? null,
    effect: a.effect ?? null,
    createdAt: a.createdAt,
  };
}

export const governanceTools: McpTool[] = [
  {
    name: 'get_request',
    tab: 'governance',
    minRole: 'creator',
    description:
      'Read the status of ONE approval request you can see — its kind, decision, who can approve it, and (once decided) the executed effect. Path: the poll step of any gated golden path. Before: you filed a request (request_promotion / request_certification / import_product) and got a requestId. Governance: scoped by rank-aware canSee — your own requests always; +your domain if Builder+; tenant-wide if Admin. An id you cannot see is not_found (no existence leak).',
    inputSchema: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'The requestId from a pending handle.' } },
      required: ['requestId'],
      examples: [{ requestId: 'apr_ab12cd34' }],
    },
    call: async (user, args) => {
      const id = str(args.requestId).trim();
      if (!id) fail('get_request needs a `requestId`', 400);
      const a = getApproval(id);
      // Not-found and not-visible are indistinguishable (no existence leak).
      if (!a || !canSee(actor(user), a)) fail('Request not found', 404);
      return requestView(a, user);
    },
  },
  {
    name: 'list_approvals',
    tab: 'governance',
    minRole: 'creator',
    description:
      'List the approval queue SCOPED to you: your own requests always; +your domain’s items if you are a Builder/Domain-admin; tenant-wide if Admin. Filter by `status` (pending|approved|rejected), `kind`, or `mine:true` (only requests you raised). Path: a decider’s daily loop — list_approvals → get_request → decide_approval. Governance: rank-aware canSee filters every row; nothing outside your scope is ever returned.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'Filter by decision status.' },
        kind: { type: 'string', description: 'Filter by approval kind (e.g. artifact_promote, promote_certify, dataset_promote).' },
        mine: { type: 'boolean', description: 'Only requests YOU raised.' },
      },
      examples: [{ status: 'pending' }, { mine: true }],
    },
    call: async (user, args) => {
      const status = str(args.status).trim() as ApprovalStatus;
      const kind = str(args.kind).trim();
      const mine = args.mine === true;
      const rows = listApprovals(status ? { status } : {})
        .filter((a) => canSee(actor(user), a))
        .filter((a) => (kind ? a.kind === kind : true))
        .filter((a) => (mine ? a.requestedBy === user.id : true))
        .map((a) => requestView(a, user));
      return { role: roleLabel(user.role), count: rows.length, approvals: rows };
    },
  },
  {
    name: 'decide_approval',
    tab: 'governance',
    minRole: 'builder',
    description:
      'APPROVE or DENY a request you are entitled to decide — and on approve, EXECUTE the governed effect (the approval IS the action: promote/certify/grant/deploy runs now). Path: the decide step of every gated golden path. Governance: rank-aware canApprove re-gate PER ITEM — a domain item needs a Builder/Domain-admin of that domain; a certification (scope tenant) needs a platform Admin; a creator can never decide. `remember:true` writes a standing policy where the item is rememberable — NOTE: standing policy is currently IN-PROCESS only (session-scoped), so it is not yet a durable tenant rule. Idempotency: an already-decided request → conflict.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'The requestId to decide.' },
        decision: { type: 'string', enum: ['approve', 'deny'], description: 'approve (run the effect) or deny.' },
        remember: { type: 'boolean', description: 'On approve, also write a standing policy (where rememberable; in-process only today).' },
      },
      required: ['requestId', 'decision'],
      examples: [{ requestId: 'apr_ab12cd34', decision: 'approve' }],
    },
    call: async (user, args) => {
      const id = str(args.requestId).trim();
      if (!id) fail('decide_approval needs a `requestId`', 400);
      const decision = str(args.decision) === 'deny' ? 'reject' : str(args.decision) === 'approve' ? 'approve' : '';
      if (!decision) fail('decide_approval needs `decision` = approve | deny', 400);

      const a = getApproval(id);
      if (!a || !canSee(actor(user), a)) fail('Request not found', 404); // no existence leak
      if (a.status !== 'pending') fail(`Already ${a.status}`, 409);
      // PER-ITEM rank-aware re-gate — NOT just the builder floor. A certification
      // (scope tenant / approverRole admin) needs an Admin; a creator never reaches
      // here (floor), and a domain_admin cannot decide cross-domain or certify.
      if (!canApprove(actor(user), a)) {
        const need = a.scope === 'tenant' ? 'a platform Admin' : `a ${roleLabel(a.approverRole)} of ${a.domain}`;
        fail(`This request needs ${need}`, 403);
      }

      if (decision === 'reject') {
        const rejected = decide(id, 'reject', user.id);
        if (!rejected) fail('Could not decide (raced?)', 409);
        audit({ actor: user.id, action: 'deny', subject: rejected.tool || rejected.kind, domain: rejected.domain, reason: `${rejected.kind} denied`, detail: { approvalId: rejected.id } });
        return { decided: 'denied', requestId: rejected.id, kind: rejected.kind };
      }

      // Approve === act. APPLY THE EFFECT FIRST (mirrors approve_promotion): only on
      // a successful, ok effect do we transition the record to `approved`, so a gate
      // refusal or effect failure leaves the request PENDING + retriable — never a
      // permanently-approved item with no effect. Failures surface as a typed error.
      let effect;
      try {
        effect = await applyEffect(a, { id: user.id, role: user.role, domains: user.domains }, buildEffectDeps());
      } catch (e) {
        // The effect's own gate refused (e.g. certify needs Admin) or it errored —
        // leave the request pending, propagate the typed status.
        const status = (e as { status?: number }).status ?? 502;
        fail(`Effect failed — request left pending: ${(e as Error).message}`, status);
      }
      if (!effect.ok) {
        // The effect ran but reported failure (e.g. a physical publish that failed);
        // record it for the audit trail and leave the request pending.
        recordEffect(a.id, { applied: effect.applied, live: false, publish: effect.publish });
        fail(`Effect did not complete — request left pending: ${effect.applied}`, 502);
      }

      const updated = decide(id, 'approve', user.id);
      if (!updated) fail('Could not decide (raced?)', 409); // a racing approver won it

      let remembered = false;
      if (args.remember === true && updated.rememberable) {
        remember({ kind: updated.kind, payload: updated.payload, domain: updated.domain, createdBy: user.id, fromApproval: updated.id });
        remembered = true;
      }
      recordEffect(updated.id, { applied: effect.applied, live: effect.live, publish: effect.publish });
      audit({ actor: user.id, action: effect.audit.action, subject: effect.audit.subject, domain: updated.domain, reason: effect.audit.reason, detail: { approvalId: updated.id, ...effect.audit.detail } });
      return {
        decided: 'approved',
        requestId: updated.id,
        kind: updated.kind,
        effect: { applied: effect.applied, live: effect.live, ok: effect.ok, audit: effect.audit.action },
        ...(remembered ? { remembered } : {}),
      };
    },
  },
  {
    name: 'request_certification',
    tab: 'governance',
    extraTabs: ['marketplace'],
    minRole: 'builder',
    description:
      'FILE a rung-2 CERTIFICATION request (a Domain asset → the cross-domain MARKETPLACE) — the domain vouches for its artifact. Works for any kind: dataset, knowledge, connection, dashboard, model, app. Path: the certify step of the ladder. Before: the artifact is already a Shared/Domain asset (promote it first with request_promotion). After: a platform ADMIN runs `decide_approval`. Governance: TRIGGER = a Builder/Domain-admin IN the artifact’s domain (owner-not-required — the domain vouches); APPROVE = a platform Admin only. Returns the pending handle; it does NOT certify.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['dataset', 'knowledge', 'connection', 'dashboard', 'model', 'app', 'agent_system'], description: 'What to certify (a Shared/Domain asset).' },
        id: { type: 'string', description: 'The domain asset id.' },
        mode: { type: 'string', description: 'Optional marketplace consumption mode (e.g. read-in-place | fork-allowed for models).' },
      },
      required: ['kind', 'id'],
      examples: [{ kind: 'knowledge', id: 'wf_ab12cd' }, { kind: 'model', id: 'churn_model', mode: 'read-in-place' }],
    },
    call: async (user, args) => {
      const kind = str(args.kind).trim();
      const id = str(args.id).trim();
      if (!id) fail('request_certification needs an `id`', 400);
      if (!isLadderKind(kind) && kind !== 'dataset') {
        fail('request_certification needs `kind` = dataset | knowledge | connection | dashboard | model | app', 400);
      }
      // Datasets keep their own two-step certification path; here we file the
      // ladder kinds. (Dataset certification: use the Data tab / requestCertification.)
      if (kind === 'dataset') fail('Dataset certification is filed via the Data tab certification flow (requestCertification).', 400);
      const approval = await fileArtifactCertification(kind as LadderKind, id, user, { mode: str(args.mode) || undefined });
      return pendingHandle(approval, { artifactKind: kind, domain: approval.domain });
    },
  },
  {
    name: 'get_lineage',
    tab: 'governance',
    extraTabs: ['data', 'metrics', 'dashboards', 'science', 'marketplace', 'bigbets', 'software'],
    minRole: 'creator',
    description:
      'Get ONE normalized lineage graph `{nodes, edges}` for any artifact: `dataset:<id>`, `metric:<id>`, `dashboard:<id>`, `model:<id>`, `listing:<id>`, `bet:<id>` or `app:<id>`. Path: understand what an artifact is built from + who consumes it, across tabs. Governance: read-only, scoped — an unseeable ROOT is not_found; individual nodes you cannot see render as `{redacted:true, kind}` (existence, never content).',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'A "<kind>:<id>" reference, e.g. "dataset:ds_ab12cd" or "bet:bet_ab12cd34".' } },
      required: ['ref'],
      examples: [{ ref: 'dataset:ds_ab12cd' }, { ref: 'bet:bet_ab12cd34' }],
    },
    call: async (user, args) => {
      const ref = str(args.ref).trim();
      if (!ref) fail('get_lineage needs a `ref` (e.g. "dataset:ds_ab12cd")', 400);
      return getLineage(ref, user);
    },
  },
  {
    name: 'import_product',
    tab: 'marketplace',
    minRole: 'creator',
    description:
      'Import a certified marketplace listing into your domain — as a GOVERNED policy-compiler GRANT (RLS-scoped), NEVER a bytes copy (except explicit fork/instance/template modes, which are Builder+). Path: reuse from the marketplace. Governance: an OPEN-policy grant is compiled NOW (OPA row-filter / Cube RLS / OpenSearch DLS per type+mode); an APPROVAL-policy import returns the pending handle (the owner’s domain approves via decide_approval). Read-grant is a creator right; fork/instance/template need Builder+ (re-checked in-lib).',
    inputSchema: {
      type: 'object',
      properties: {
        listingId: { type: 'string', description: 'The certified listing id (from browse_marketplace).' },
        mode: { type: 'string', enum: ['read-grant', 'fork', 'deploy-instance', 'template'], description: 'Import mode (default = the listing’s default; fork/instance/template are Builder+).' },
      },
      required: ['listingId'],
      examples: [{ listingId: 'lst_ab12cd', mode: 'read-grant' }],
    },
    call: async (user, args) => {
      const listingId = str(args.listingId).trim();
      if (!listingId) fail('import_product needs a `listingId`', 400);
      const mode = (str(args.mode) || undefined) as ImportMode | undefined;
      const viewer = { id: user.id, domains: user.domains, role: user.role };
      const result = await importAdapter.import(listingId, viewer, mode);
      if (result.pending) {
        // Approval-policy import → the canonical pending handle (the owner domain decides).
        const a = result.grant.approvalId ? getApproval(result.grant.approvalId) : null;
        if (a) return pendingHandle(a, { grantId: result.grant.id, mode: result.grant.mode, note: result.note });
        return { status: 'pending', requestId: result.grant.approvalId ?? result.grant.id, grantId: result.grant.id, mode: result.grant.mode, note: result.note };
      }
      return {
        status: 'granted',
        grantId: result.grant.id,
        mode: result.grant.mode,
        enforcedBy: result.grant.enforcedBy,
        scope: result.grant.scope,
        derivedId: result.grant.derivedId ?? null,
        note: result.note,
      };
    },
  },
  {
    name: 'get_policy_view',
    tab: 'governance',
    minRole: 'builder',
    description:
      'Read the consolidated, READ-ONLY policy plane — who-can-do-what end-to-end: role-derived grants + dynamic access grants + egress allowlist + standing policies, each labelled with the engine it compiles to (OPA / Cube / OpenSearch-DLS), PLUS the capability-profile catalogue. Purpose: understand the governance posture before you act. Governance: gated on the `policy.view` right (re-checked in-lib, NOT just the Builder floor) — a creator is refused; a Builder/Domain-admin sees ONLY their own domain(s); an Admin sees tenant-wide. Read-only: editing lives in each tab, overrides are Admin-only.',
    inputSchema: { type: 'object', properties: {}, examples: [{}] },
    call: async (user) => {
      // Re-gate authoritatively on the policy.view right (the real control).
      if (!canViewPolicyPlane(user.role)) {
        fail('Viewing the policy plane requires the policy.view right (Builder or Admin)', 403);
      }
      const scope = user.role === 'admin' ? undefined : user.domains;
      const users = await listUsers();
      return {
        plane: consolidatedPlane(users, scope),
        sources: policySources(),
        egress: listEgress(scope),
        standing: listStanding(scope),
        canOverride: user.role === 'admin',
      };
    },
  },
  {
    name: 'get_cost',
    tab: 'governance',
    minRole: 'creator',
    description:
      'Read the spend caps in your scope + their live status (projected spend vs limit, and which are near/over). Purpose: know the cost guardrails before running metered work. Governance: read-only; scope is derived from your identity — a creator/Builder sees their own domain’s caps (+ key caps), an Admin sees tenant-wide. HONESTY: cap ENFORCEMENT is live (checkCap), but spend accrual is in-process today (a real deploy reconciles LiteLLM usage); setting a cap is a governance mutation gated elsewhere (Builder+), not exposed here.',
    inputSchema: { type: 'object', properties: {}, examples: [{}] },
    call: async (user) => {
      const scope = user.role === 'admin' ? undefined : user.domains;
      const caps = listCaps(scope);
      const status = caps.map((c) => {
        const check = checkCap({ scope: c.scope, subject: c.subject, amount: 0, modelClass: c.modelClass });
        return {
          id: c.id,
          scope: c.scope,
          subject: c.subject,
          limit: c.limit,
          period: c.period,
          modelClass: c.modelClass ?? null,
          projectedSpend: check.projected,
          withinCap: check.allowed,
          alert: !check.allowed ? 'over' : check.cap && check.projected >= check.cap.limit * 0.8 ? 'near' : 'ok',
        };
      });
      return {
        canSetCap: roleAtLeast(user.role, 'builder'),
        caps: status,
        alerts: status.filter((s) => s.alert !== 'ok'),
        note: 'Cap enforcement is live (checkCap); spend accrual is in-process offline and reconciles to LiteLLM usage on a real deploy.',
      };
    },
  },
];

// Keep the ApprovalKind type referenced (used in schema doc + tests via wire).
export type GovernanceApprovalKind = ApprovalKind;
