/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Approval } from '../approvals.ts';
import type { AuditAction } from './audit.ts';
import { addAccessGrant, addEgressEndpoint, isEgressAllowed } from './policy-view.ts';
import { writeGrantsToOpa } from './roles.ts';
import {
  certify as certifyDataset,
  type Principal,
  type PromotionRequest,
  type CertificationRequest,
} from '../data/store.ts';
import type { PublishOutcome } from '../data/publish.ts';
import { applyApprovedFilePromotion, type FilePromotionRequest } from '../files/store.ts';

/**
 * The approval-IS-an-action executor (governance-golden-path.md key principle).
 * On Approve, the platform doesn't just flip a flag — it EXECUTES the governed
 * effect behind the card: deploy the app (Argo), grant access (policy compiler →
 * OPA/DLS), allowlist the endpoint (egress proxy), promote/certify, or run the
 * queued action. The route then writes audit + (optionally) a standing policy.
 *
 * Each effect is a per-source ADAPTER with a live path and an offline-mock path.
 * Unwired backends (Argo, the egress proxy) are mocked for `kind` and clearly
 * marked `live:false`; the policy/access/egress effects mutate the authoritative
 * in-process plane (policy-view) AND best-effort push to OPA, so the consumer
 * truly can query / the endpoint truly is allowlisted in the teaching flow.
 */

export type EffectResult = {
  ok: boolean;
  /** Human summary of what the approval did (shown on the card + audit). */
  applied: string;
  /** True only when a real backend confirmed the effect; mock otherwise. */
  live: boolean;
  audit: { action: AuditAction; subject: string; reason: string; detail: Record<string, unknown> };
  /** Set when the effect created an OPA grant (access requests). */
  grant?: { principal: string; tool: string };
  /** Set by the physical dataset publish (T8) — ok/fqn/error for honest status. */
  publish?: { ok: boolean; fqn: string; error?: string; mode?: string; cubeView?: string | null };
};

/** The approving human: the id (legacy string form) or the full session identity —
 *  the `dataset_promote` publish needs the REAL role + domains so the CTAS identity
 *  is the approver's, never a synthesized one. */
export type EffectApprover = string | { id: string; role: Principal['role']; domains: string[] };

/** Server-injected effect backends. `publishPromotion` is the physical dataset
 *  publish (server-only build runner) — REQUIRED for `dataset_promote`, injected by
 *  the route so this module (and its tests) stay free of server-only imports. */
export type EffectDeps = {
  publishPromotion?: (req: PromotionRequest, approver: Principal) => Promise<PublishOutcome>;
};

function s(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}

function approverId(approver: EffectApprover): string {
  return typeof approver === 'string' ? approver : approver.id;
}

/** The approver as a data-store Principal — the REAL identity when the caller
 *  supplied one; the legacy synthesized fallback (role floor) otherwise. */
function approverPrincipal(approver: EffectApprover, fallbackRole: Principal['role'], domain: string): Principal {
  if (typeof approver === 'string') return { id: approver, role: fallbackRole, domains: [domain] };
  return { id: approver.id, role: approver.role, domains: approver.domains };
}

/**
 * Execute the governed effect for an APPROVED item. Idempotent per call; the
 * caller guarantees the item was pending and the approver was in scope.
 */
export async function applyEffect(a: Approval, approver: EffectApprover, deps: EffectDeps = {}): Promise<EffectResult> {
  const p = a.payload ?? {};
  const who = approverId(approver);
  switch (a.kind) {
    case 'deploy_review': {
      // Live path = Argo CD sync; unwired here, so mock + mark live:false.
      const app = s(p.app, a.title);
      return {
        ok: true,
        applied: `Deployed ${app} via Argo CD (mock) to ${s(p.namespace, 'agentic-os')}.`,
        live: false,
        audit: {
          action: 'deploy',
          subject: app,
          reason: `Deploy-review approved by ${who}`,
          detail: { app, resources: p.resources, cost: p.cost },
        },
      };
    }
    case 'access_request': {
      // Policy-compiler grant → the consumer can now query the dataset/tool.
      const principal = s(p.consumer ?? p.principal, `user:${a.requestedBy}`);
      const tool = s(p.tool ?? p.dataset, 'query');
      const row = addAccessGrant({ principal, tool, domain: a.domain });
      const opa = await writeGrantsToOpa(principal, [tool]);
      return {
        ok: true,
        applied: `Granted ${principal} → ${tool} (compiled to ${row.compiledTo}${opa.live ? ', live in OPA' : ', mock'}).`,
        live: opa.live,
        grant: { principal, tool },
        audit: {
          action: 'access.grant',
          subject: `${principal}→${tool}`,
          reason: `Access request approved by ${who}`,
          detail: { principal, tool, dataset: p.dataset },
        },
      };
    }
    case 'egress_request': {
      const endpoint = s(p.endpoint, 'https://example.com');
      addEgressEndpoint(endpoint, a.domain, who);
      return {
        ok: true,
        applied: `Allowlisted egress endpoint ${endpoint} (mock proxy) — now reachable.`,
        live: false,
        audit: {
          action: 'egress.allow',
          subject: endpoint,
          reason: `Egress request approved by ${who}`,
          detail: { endpoint, allowed: isEgressAllowed(endpoint) },
        },
      };
    }
    case 'autonomous_out_of_policy': {
      const action = s(p.action, a.title);
      return {
        ok: true,
        applied: `Ran the queued autonomous action "${action}" once (mock).`,
        live: false,
        audit: {
          action: 'approve',
          subject: action,
          reason: `Out-of-policy action approved once by ${who}`,
          detail: { action, agent: a.agent },
        },
      };
    }
    case 'dataset_promote': {
      // Approval IS the action — and the action is PHYSICAL (T8): the injected
      // publisher runs the promote adapter-set (governed CTAS as the APPROVING
      // Builder — never the requester — then probe + OPA push + conformance) and
      // flips the registry tier ONLY on ✓. A failed materialization returns the
      // real error with the tier unchanged (the honesty contract).
      const req = a.payload as unknown as PromotionRequest;
      const approverP = approverPrincipal(approver, 'builder', a.domain);
      if (!deps.publishPromotion) {
        // Fail LOUD: nothing may flip a tier without the physical publish.
        throw new Error('dataset_promote requires the physical publisher (publishPromotion dep not injected)');
      }
      const out = await deps.publishPromotion(req, approverP);
      if (!out.ok) {
        return {
          ok: false,
          applied: `Physical publish FAILED — “${req.datasetName}” stays a private dataset (tier unchanged): ${out.error}`,
          live: false,
          publish: { ok: false, fqn: out.fqn, error: out.error, mode: out.mode },
          audit: {
            action: 'approve',
            subject: req.datasetName,
            reason: `Dataset promotion approved by ${who} but the physical publish FAILED (tier unchanged)`,
            detail: { datasetId: req.datasetId, fqn: out.fqn, error: out.error, mode: out.mode },
          },
        };
      }
      return {
        ok: true,
        applied: `Published “${out.dataset.name}” → ${out.fqn} (${out.mode}${out.cubeView ? `; Cube view '${out.cubeView}' delivered` : ''}).`,
        live: out.mode === 'live',
        publish: { ok: true, fqn: out.fqn, mode: out.mode, cubeView: out.cubeView },
        audit: {
          action: 'approve',
          subject: out.dataset.name,
          reason: `Dataset promotion approved by ${who} — physically published as the approver`,
          detail: { datasetId: out.dataset.id, tier: out.dataset.tier, fqn: out.fqn, mode: out.mode },
        },
      };
    }
    case 'dataset_certify': {
      // Approval IS the action: certify the asset → data product (marketplace-listed).
      // The route already enforced an in-scope Admin approver.
      const req = a.payload as unknown as CertificationRequest;
      const approverP = approverPrincipal(approver, 'admin', a.domain);
      const ds = certifyDataset(req.datasetId, approverP, { level: req.level, visibility: req.visibility });
      return {
        ok: true,
        applied: `Certified “${ds.name}” → data product (listed in the marketplace).`,
        live: true,
        audit: {
          action: 'approve',
          subject: ds.name,
          reason: `Dataset certification approved by ${who}`,
          detail: { datasetId: ds.id, tier: ds.tier },
        },
      };
    }
    case 'promote_certify': {
      const artifact = s(p.artifact ?? p.dataset, a.title);
      const stage = s(p.stage, 'certified');
      return {
        ok: true,
        applied: `Promoted ${artifact} → ${stage} (mock OpenMetadata + registry).`,
        live: false,
        audit: {
          action: 'approve',
          subject: artifact,
          reason: `Promote/certify approved by ${who}`,
          detail: { artifact, stage },
        },
      };
    }
    case 'file_promote': {
      // Approval IS the action: actually move the file dataset→asset and re-govern
      // it (bytes move to the domain prefix, DLS grants set) so the domain can read
      // it. The route already enforced an in-scope Builder/Admin approver.
      const req = a.payload as unknown as FilePromotionRequest;
      const approverP = approverPrincipal(approver, 'builder', a.domain);
      const file = applyApprovedFilePromotion(req, approverP);
      return {
        ok: true,
        applied: `Shared “${file.name}” → domain asset (readable by the ${a.domain} domain).`,
        live: true,
        audit: {
          action: 'approve',
          subject: file.name,
          reason: `File promotion approved by ${who}`,
          detail: { fileId: file.id, tier: file.tier, visibility: file.visibility },
        },
      };
    }
    // Legacy agent write-backs — consolidated here for the control plane. The
    // rich apply (CRM patch / curate fact) stays in the Agents route; here we
    // record that the held action was cleared.
    case 'connection_write':
    case 'knowledge_certify':
    default: {
      return {
        ok: true,
        applied: `Cleared held action (${a.kind}) — applied (mock).`,
        live: false,
        audit: {
          action: 'approve',
          subject: a.tool || a.kind,
          reason: `${a.kind} approved by ${who}`,
          detail: { kind: a.kind, agent: a.agent },
        },
      };
    }
  }
}
