/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Approval } from '../approvals.ts';
import type { AuditAction } from './audit.ts';
import { addAccessGrant, addEgressEndpoint, isEgressAllowed } from './policy-view.ts';
import { writeGrantsToOpa } from './roles.ts';
import {
  applyApprovedPromotion,
  certify as certifyDataset,
  type Principal,
  type PromotionRequest,
  type CertificationRequest,
} from '../data/store.ts';

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
};

function s(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}

/**
 * Execute the governed effect for an APPROVED item. Idempotent per call; the
 * caller guarantees the item was pending and the approver was in scope.
 */
export async function applyEffect(a: Approval, approver: string): Promise<EffectResult> {
  const p = a.payload ?? {};
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
          reason: `Deploy-review approved by ${approver}`,
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
          reason: `Access request approved by ${approver}`,
          detail: { principal, tool, dataset: p.dataset },
        },
      };
    }
    case 'egress_request': {
      const endpoint = s(p.endpoint, 'https://example.com');
      addEgressEndpoint(endpoint, a.domain, approver);
      return {
        ok: true,
        applied: `Allowlisted egress endpoint ${endpoint} (mock proxy) — now reachable.`,
        live: false,
        audit: {
          action: 'egress.allow',
          subject: endpoint,
          reason: `Egress request approved by ${approver}`,
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
          reason: `Out-of-policy action approved once by ${approver}`,
          detail: { action, agent: a.agent },
        },
      };
    }
    case 'dataset_promote': {
      // Approval IS the action: actually move the dataset → asset (governed tier),
      // so Cube/metrics can read the Gold mart. The route already enforced that the
      // approver was an in-scope Builder, so synthesise that Principal here.
      const req = a.payload as unknown as PromotionRequest;
      const approverP: Principal = { id: approver, role: 'builder', domains: [a.domain] };
      const ds = applyApprovedPromotion(req, approverP);
      return {
        ok: true,
        applied: `Promoted “${ds.name}” → data asset (governed; Cube can read the Gold mart).`,
        live: true,
        audit: {
          action: 'approve',
          subject: ds.name,
          reason: `Dataset promotion approved by ${approver}`,
          detail: { datasetId: ds.id, tier: ds.tier },
        },
      };
    }
    case 'dataset_certify': {
      // Approval IS the action: certify the asset → data product (marketplace-listed).
      // The route already enforced an in-scope Admin approver.
      const req = a.payload as unknown as CertificationRequest;
      const approverP: Principal = { id: approver, role: 'admin', domains: [a.domain] };
      const ds = certifyDataset(req.datasetId, approverP, { level: req.level, visibility: req.visibility });
      return {
        ok: true,
        applied: `Certified “${ds.name}” → data product (listed in the marketplace).`,
        live: true,
        audit: {
          action: 'approve',
          subject: ds.name,
          reason: `Dataset certification approved by ${approver}`,
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
          reason: `Promote/certify approved by ${approver}`,
          detail: { artifact, stage },
        },
      };
    }
    // Legacy agent write-backs — consolidated here for the control plane. The
    // rich apply (CRM patch / curate fact) stays in the Agents route; here we
    // record that the held action was cleared.
    case 'connection_write':
    case 'knowledge_certify':
    case 'file_promote':
    default: {
      return {
        ok: true,
        applied: `Cleared held action (${a.kind}) — applied (mock).`,
        live: false,
        audit: {
          action: 'approve',
          subject: a.tool || a.kind,
          reason: `${a.kind} approved by ${approver}`,
          detail: { kind: a.kind, agent: a.agent },
        },
      };
    }
  }
}
