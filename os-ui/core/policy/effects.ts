/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Approval } from '@core/policy/approvals';
import type { AuditAction } from '@core/policy/audit';
import { addAccessGrant, addEgressEndpoint, isEgressAllowed } from '@core/policy/policy-view';
import { writeGrantsToOpa } from '@core/policy/roles';
import {
  certify as certifyDataset,
  parsePersonalDataConfirmation,
  policyPushReport as datasetPolicyPushReport,
  type Principal,
  type PromotionRequest,
  type CertificationRequest,
} from '@tabs/data/lib/store';
import type { PublishOutcome } from '@tabs/data/lib/publish';
import { applyApprovedFilePromotion, type FilePromotionRequest } from '@tabs/files/lib/store';
// The ladder's per-kind promote/certify appliers. The SYNC + in-memory ones
// (knowledge/dashboard/agent_system) are dispatched here directly; the
// async + server-only ones (connection/artifact/app) arrive as injected deps so
// this module (and its tests) stay free of the heavy object-store cache imports —
// exactly the isolation pattern `publishPromotion` already uses.
import { publishWorkflow, certifyWorkflow } from '@tabs/knowledge/lib/store';
import { promotePersonalKnowledge, certifyPersonalKnowledge } from '@tabs/knowledge/lib/personal-store';
import { transitionDashboard } from '@tabs/dashboards/lib/store';
import { promoteSystem } from '@tabs/agents/lib/store';
import { runWithPromotion } from '@core/infra/git-promote';
import { authorize, workflowWriteTestGate, workflowWriteDecision } from '@core/infra/governed';

/**
 * The approval-IS-an-action executor (governance-golden-path.md key principle).
 * On Approve, the platform doesn't just flip a flag — it EXECUTES the governed
 * effect behind the card: deploy the app (the OS's own app runner — there is no GitOps
 * controller and no image builder in this stack), grant access (policy compiler →
 * OPA/DLS), allowlist the endpoint (egress proxy), promote/certify, or run the
 * queued action. The route then writes audit + (optionally) a standing policy.
 *
 * Each effect is a per-source ADAPTER with a live path and an offline-mock path.
 * Unwired backends (the egress proxy) are mocked for `kind` and clearly
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
  publish?: { ok: boolean; fqn: string; error?: string; mode?: string };
  /** Set by a dataset tier change: the immediate OPA governance push and, if it failed, its warning. */
  policyPush?: { ok: boolean; fqn: string; visibility: string; code?: string; detail?: string; warning?: string };
};

/** The approving human: the id (legacy string form) or the full session identity —
 *  the `dataset_promote` publish needs the REAL role + domains so the CTAS identity
 *  is the approver's, never a synthesized one. */
export type EffectApprover = string | { id: string; role: Principal['role']; domains: string[] };

/** Server-injected effect backends. `publishPromotion` is the physical dataset
 *  publish (server-only build runner) — REQUIRED for `dataset_promote`, injected by
 *  the route so this module (and its tests) stay free of server-only imports. */
/** The applied summary an injected ladder promote/certify returns (name + tier). */
export type LadderApplied = { id: string; name: string; visibility: string };
/** Advance one rung of an async, server-only ladder artifact AS the approver. */
export type LadderApplier = (id: string, approver: { id: string; role: Principal['role']; domains: string[] }) => Promise<LadderApplied>;

export type EffectDeps = {
  publishPromotion?: (req: PromotionRequest, approver: Principal) => Promise<PublishOutcome>;
  /** Connection promote/certify (Personal→Shared→Certified single-step advance). */
  promoteConnection?: LadderApplier;
  /** Artifact promote/certify (Personal→Shared→Certified single-step advance). */
  promoteArtifact?: LadderApplier;
  /** App promote/certify (Personal→Shared→Certified single-step advance). */
  promoteApp?: LadderApplier;
  /** Decide a Software deploy-review card AS the approver — flips the software
   *  release/app deploy state (review → live | preview) so approving the app_deploy
   *  item in Policies & Approvals actually clears the app's "awaiting review".
   *  Injected by the route (server-only `review.ts`) so this module stays light. */
  decideDeploy?: (
    cardId: string,
    approver: { id: string; role: Principal['role']; domains: string[] },
    decision: 'approve' | 'deny',
  ) => Promise<{ appName: string; state: string; live: boolean }>;
  /** Approve an operational exposure's WRITE actions (`exposure_action_enable`):
   *  flips the exposure's `writeApproved` so the create/update action tools compile
   *  onto the connection's capability profile. Injected by the route so this module
   *  (and its tests) stay free of the server-only exposures store. */
  enableExposureActions?: (
    exposureId: string,
    approver: { id: string; role: Principal['role']; domains: string[] },
  ) => Promise<{ exposureId: string; connectionName: string }>;
  /** Generate + FREEZE an OKF bundle for a knowledge product AT CERTIFY TIME
   *  (OKF decision #2): a certified Marketplace knowledge product carries its bundle,
   *  generated once at certification. Best-effort — a freeze hiccup never rolls back
   *  the certification. Injected by the route/tool layer so this module stays free of
   *  the server-only object-store + zip imports (same pattern as the other deps). */
  freezeKnowledgeBundle?: (
    workflowId: string,
    approver: { id: string; role: Principal['role']; domains: string[] },
  ) => Promise<{ fileId: string } | null>;
  /** EXECUTE an APPROVED held connection write (C3): resolve the payload's connection +
   *  tool + args and run it through the governed `approveOnce` path AS the approver (the
   *  capability profile / four-layer intersection is re-checked server-side, so the held
   *  payload can never smuggle a wider write). Returns the executor's honest {ok, reason}.
   *  Injected by the route so this module (and its tests) stay free of the connections store. */
  /** Run a held Software-app write (`connection_write` whose payload names an `appId`). Wired
   *  by `buildEffectDeps` from the registered applier (`app-write-port.ts`). */
  applyAppWrite?: (req: { appId: string; tool: string; args: Record<string, unknown>; requestedBy: string }) => Promise<{ ok: boolean; reason: string }>;
  applyConnectionWrite?: (
    payload: { connId: string; tool: string; args: Record<string, unknown>; requestedBy?: string },
    approver: { id: string; role: Principal['role']; domains: string[] },
  ) => Promise<{ ok: boolean; reason: string; attribution?: Record<string, string> }>;
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
/** What the deciding human added to the decision itself (beyond approve). `personalData` is the
 *  certifier's confirmation for a Company certification under the personal-data rule
 *  (`{ confirmed: true, reason }`); untrusted shape, parsed by the Data store. */
export type EffectDecision = { personalData?: unknown };

export async function applyEffect(a: Approval, approver: EffectApprover, deps: EffectDeps = {}, decision: EffectDecision = {}): Promise<EffectResult> {
  const p = a.payload ?? {};
  const who = approverId(approver);
  // A2 — an approval raised by a PARKED agent run: the approver AUTHORISES, the RUNNER executes.
  // There is deliberately NO approver-side effect here: `decide()` fires the registered resume
  // hook, which continues the run's LangGraph thread under the runner's (live-re-read) principal
  // and executes the held call through the same governed executor the run uses. The record's
  // `resume` field says what that did; `live:false` because nothing ran AS the approver.
  if (a.runId) {
    return {
      ok: true,
      applied: `Authorised ${a.tool} for agent run ${a.runId} (${a.node ?? 'agent'}) — the run resumes as its runner ${a.runner?.id ?? a.requestedBy} and executes the call.`,
      live: false,
      audit: {
        action: 'approve',
        subject: a.tool || a.kind,
        reason: `Held agent-run write approved by ${who}; executed by the runner on resume`,
        detail: { kind: a.kind, runId: a.runId, systemId: a.systemId, node: a.node, tool: a.tool, runner: a.runner?.id },
      },
    };
  }
  switch (a.kind) {
    case 'app_deploy': {
      // Approval IS the action: a Software deploy-review filed by `requestDeploy`.
      // Approving it in Policies & Approvals must write BACK to the software release
      // record — flip the app's deploy state review → live (or preview on reject) so
      // the Software app no longer shows "awaiting review". Without this dep the item
      // would be marked approved in the queue but the app would stay stuck. We route
      // through the SAME `decideDeploy` seam the Software UI uses (scan re-check +
      // envelope recorded + runner rolled), so both front doors converge.
      const cardId = s(p.cardId);
      if (!cardId) throw new Error('app_deploy requires payload.cardId');
      if (!deps.decideDeploy) throw new Error('app_deploy requires the injected decideDeploy applier (not injected)');
      const full = typeof approver === 'string'
        ? { id: approver, role: 'builder' as Principal['role'], domains: [a.domain] }
        : approver;
      const out = await deps.decideDeploy(cardId, full, 'approve');
      return {
        ok: true,
        applied: `Deploy approved: “${out.appName}” is now ${out.state}${out.live ? '' : ' (runner pending)'}.`,
        live: out.live,
        audit: {
          action: 'deploy',
          subject: out.appName,
          reason: `Software deploy-review approved by ${who}`,
          detail: { cardId, appId: p.appId, state: out.state },
        },
      };
    }
    case 'deploy_review': {
      // Live path = the in-cluster app runner; unwired here, so mock + mark live:false.
      const app = s(p.app, a.title);
      return {
        ok: true,
        applied: `Deployed ${app} (mock) to ${s(p.namespace, 'agentic-os')}.`,
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
    case 'exposure_action_enable': {
      // Approval IS the action: flip the exposure's `writeApproved` so its create/
      // update action tools compile onto the connection profile (read/search were
      // already live). Recomputed server-side AS the approver via the injected dep —
      // the held item cannot smuggle a wider grant.
      const exposureId = s(p.exposureId);
      if (!exposureId) throw new Error('exposure_action_enable requires payload.exposureId');
      if (!deps.enableExposureActions) throw new Error('exposure_action_enable requires the injected enableExposureActions applier (not injected)');
      const approverA = approverPrincipal(approver, 'admin', a.domain);
      const out = await deps.enableExposureActions(exposureId, approverA);
      return {
        ok: true,
        applied: `Write actions enabled on exposure “${out.connectionName}” — create/update tools now compiled.`,
        live: true,
        audit: {
          action: 'approve',
          subject: out.exposureId,
          reason: `Exposure write-action enablement approved by ${who}`,
          detail: { exposureId: out.exposureId, connection: out.connectionName },
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
        applied: `Published “${out.dataset.name}” → ${out.fqn} (${out.mode}).`,
        live: out.mode === 'live',
        publish: { ok: true, fqn: out.fqn, mode: out.mode },
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
      // The personal-data rule runs inside certify (the choke point); the approver's confirmation rides along.
      const ds = certifyDataset(req.datasetId, approverP, { level: req.level, personalData: parsePersonalDataConfirmation(decision.personalData) });
      // The immediate OPA push (readable in every domain now) — a failure is shown, never silent.
      const push = await datasetPolicyPushReport(ds.id);
      return {
        ok: true,
        applied: `Certified “${ds.name}” → Company data product (readable by every domain).${push.warning ? ` WARNING: ${push.warning}` : ''}`,
        live: true,
        ...(push.policyPush ? { policyPush: push.policyPush } : {}),
        audit: {
          action: 'approve',
          subject: ds.name,
          reason: `Dataset certification approved by ${who}`,
          detail: { datasetId: ds.id, tier: ds.tier },
        },
      };
    }
    case 'artifact_promote': {
      // Rung 1 (Personal→Domain) for the formerly-DIRECT kinds. THE single seam:
      // the per-kind dispatch lives here and NOWHERE else — every UI + MCP promote
      // route files this kind and lands in this switch. The underlying store fn
      // re-enforces the Builder+domain gate (defence in depth), running AS the
      // approver identity passed in.
      return applyLadder(a, approver, deps, 'promote', who);
    }
    case 'promote_certify': {
      // Rung 2 (Domain→Marketplace). LIVE per-kind dispatch when the ladder payload
      // names an `artifactKind`; otherwise the legacy `{artifact,stage}` mock is
      // preserved for backward compatibility (old queue items still resolve).
      if (!p.artifactKind) {
        const artifact = s(p.artifact ?? p.dataset, a.title);
        const stage = s(p.stage, 'certified');
        return {
          ok: true,
          applied: `Promoted ${artifact} → ${stage} (mock registry).`,
          live: false,
          audit: {
            action: 'approve',
            subject: artifact,
            reason: `Promote/certify approved by ${who}`,
            detail: { artifact, stage },
          },
        };
      }
      return applyLadder(a, approver, deps, 'certify', who);
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
    case 'connection_write': {
      // A HELD CONNECTION WRITE (Mode-A Write-approval / Mode-B queued review): approving it
      // must EXECUTE the write, not clear it with "applied (mock)" (C3). Resolve the payload's
      // connection + tool + args and run through the governed `approveOnce` seam AS the
      // approver — the capability profile / four-layer intersection is re-checked server-side,
      // so a doctored payload can never smuggle a wider write. If execution is IMPOSSIBLE
      // (missing dep/payload), the approval outcome is ok:false with the reason — NEVER a mock.
      // A HELD APP WRITE (the app tool door files `{ appId, args }`, no connection): run it through
      // the app's own gate, as the app call would have run, with this approval as the human OK.
      // The app may have been deleted since, or the gate may now refuse: either is ok:false with
      // the reason. Never the mock clear below.
      const appId = s(p.appId);
      if (appId && !s(p.connId, s(p.connectionId))) {
        const tool = s(a.tool);
        const args = (p.args && typeof p.args === 'object' ? p.args : {}) as Record<string, unknown>;
        const detail = { kind: a.kind, appId, tool, agent: a.agent, requestedBy: a.requestedBy };
        if (!deps.applyAppWrite || !tool) {
          return {
            ok: false,
            applied: !tool
              ? 'Held app write could not be run: the approval does not name the app action.'
              : 'Held app write could not be run: this OS process cannot run app actions. Nothing was written.',
            live: false,
            audit: { action: 'approve', subject: tool || a.kind, reason: `${a.kind} approval failed (app write not runnable) — ${who}`, detail },
          };
        }
        const out = await deps.applyAppWrite({ appId, tool, args, requestedBy: a.requestedBy });
        return {
          ok: out.ok,
          applied: out.ok ? `App write executed: ${tool} — ${out.reason}` : `App write did NOT execute: ${out.reason}`,
          live: out.ok,
          audit: { action: 'approve', subject: tool, reason: `Held app write approved by ${who}`, detail },
        };
      }
      if (deps.applyConnectionWrite) {
        const connId = s(p.connId, s((p.connectionId)));
        const preview = (p.preview ?? {}) as { action?: unknown; args?: unknown };
        const tool = s(a.tool, s(preview.action));
        const args = (preview.args && typeof preview.args === 'object' ? preview.args : {}) as Record<string, unknown>;
        if (!connId || !tool) {
          return {
            ok: false,
            applied: `Held connection write could not be executed: the approval payload is missing its connection or tool.`,
            live: false,
            audit: { action: 'approve', subject: tool || a.kind, reason: `${a.kind} approval failed (incomplete payload) — ${who}`, detail: { kind: a.kind, connId, tool, agent: a.agent } },
          };
        }
        const approverP = approverPrincipal(approver, 'builder', a.domain);
        const out = await deps.applyConnectionWrite({ connId, tool, args, requestedBy: a.requestedBy }, approverP);
        // The audit names who REQUESTED the write and who APPROVED it, plus the acting user and
        // whose credential ran it (the connection's attribution, when the executor reports it).
        return {
          ok: out.ok,
          applied: out.ok ? `Connection write executed: ${tool} — ${out.reason}` : `Connection write did NOT execute: ${out.reason}`,
          live: out.ok,
          audit: {
            action: 'approve',
            subject: tool,
            reason: `Held connection write approved by ${who}`,
            detail: {
              kind: a.kind, connId, tool, agent: a.agent,
              requestedBy: a.requestedBy, approvedBy: approverP.id,
              ...(out.attribution ?? {}),
            },
          },
        };
      }
      // Fall through: other connection_write kinds (legacy agent write-backs) are
      // cleared below alongside knowledge_certify.
    }
    // eslint-disable-next-line no-fallthrough
    // Legacy agent write-backs — consolidated here for the control plane. The
    // rich apply (CRM patch / curate fact) stays in the Agents route; here we
    // record that the held action was cleared.
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

/**
 * THE UNIFIED LADDER SEAM. Every promotion (rung 1) and certification (rung 2) of
 * a formerly-DIRECT kind (knowledge/connection/artifact/dashboard/app) flows
 * through here — the ONE place the per-kind promote/certify dispatch lives. No UI
 * route and no MCP tool flips a tier without arriving in this switch, so the
 * governance back door is closed at a single point. The underlying store fn
 * re-enforces its own role+domain gate (defence in depth), acting AS the approver.
 */
async function applyLadder(
  a: Approval,
  approver: EffectApprover,
  deps: EffectDeps,
  rung: 'promote' | 'certify',
  who: string,
): Promise<EffectResult> {
  const p = a.payload ?? {};
  const kind = s(p.artifactKind);
  const id = s(p.id);
  if (!id) throw new Error(`${a.kind} requires payload.id`);
  const verb = rung === 'promote' ? 'Shared to the domain' : 'Certified to the marketplace';
  const auditBase = (subject: string, detail: Record<string, unknown>) => ({
    action: 'approve' as AuditAction,
    subject,
    reason: `${kind} ${rung} approved by ${who}`,
    detail: { artifactKind: kind, id, rung, ...detail },
  });
  const okResult = (name: string, extra: Record<string, unknown> = {}): EffectResult => ({
    ok: true,
    applied: `${verb}: “${name}”.`,
    live: true,
    audit: auditBase(name, extra),
  });

  switch (kind) {
    case 'knowledge': {
      // THE OPA DOOR for a workflow publish / certify, asked AS THE APPROVER before the store flips
      // the tier. The approval decision (role ladder + domain scope in `decide`) says WHO may decide;
      // this asks the policy engine the same question every other workflow write asks, so the
      // approval route is not a way round it. Fail-closed: no answer, no publish.
      {
        const op = rung === 'promote' ? 'publish' : 'certify';
        const asApprover = approverPrincipal(approver, rung === 'promote' ? 'builder' : 'admin', a.domain);
        const facts = { id, tier: rung === 'promote' ? 'personal' : 'shared', owner: a.requestedBy, domain: a.domain } as const;
        const seam = workflowWriteTestGate();
        const allowed = seam
          ? Boolean(await seam(op, asApprover, facts))
          : (await authorize(`user:${asApprover.id}`, 'workflow.write', workflowWriteDecision(asApprover, op, facts))).allowed;
        if (!allowed) throw Object.assign(new Error(`The workflow ${op} was refused by policy for ${asApprover.id}: the policy engine did not allow it, or did not answer. Nothing was changed.`), { status: 403 });
      }
      const rec = rung === 'promote'
        ? publishWorkflow(id, approverPrincipal(approver, 'builder', a.domain))
        : certifyWorkflow(id, approverPrincipal(approver, 'admin', a.domain));
      // Certify-time OKF freeze (decision #2): a certified knowledge product carries
      // its OKF bundle, generated once here. Best-effort — never rolls back certify.
      let frozenBundleFileId: string | undefined;
      if (rung === 'certify' && deps.freezeKnowledgeBundle) {
        try {
          const frozen = await deps.freezeKnowledgeBundle(id, approverPrincipal(approver, 'admin', a.domain));
          if (frozen) frozenBundleFileId = frozen.fileId;
        } catch {
          /* a freeze hiccup must never block certification */
        }
      }
      return okResult(rec.title, { visibility: rec.visibility, status: rec.status, ...(frozenBundleFileId ? { frozenBundleFileId } : {}) });
    }
    case 'personal_knowledge': {
      const rec = rung === 'promote'
        ? promotePersonalKnowledge(id, approverPrincipal(approver, 'builder', a.domain))
        : certifyPersonalKnowledge(id, approverPrincipal(approver, 'admin', a.domain));
      return okResult(rec.title, { visibility: rec.visibility });
    }
    case 'dashboard': {
      const rec = transitionDashboard(id, approverPrincipal(approver, rung === 'promote' ? 'builder' : 'admin', a.domain), rung);
      return okResult(rec.spec.name, { tier: rec.tier });
    }

    case 'agent_system': {
      // promoteSystem is a single-step advance (Personal→Shared→Marketplace),
      // role-gated internally exactly like promoteArtifact — sync + in-memory.
      // My → Domain is recorded in git as a MERGE from the owner's user repo (design 12): the
      // approval travels to the commit hook in the writer's async context. The decision itself
      // is unchanged — `promoteSystem` gates as before.
      const promote = () => promoteSystem(id, approverPrincipal(approver, rung === 'promote' ? 'builder' : 'admin', a.domain));
      const rec = rung === 'promote' ? runWithPromotion({ approvalId: a.id, approverId: approverId(approver) }, promote) : promote();
      return okResult(rec.name, { visibility: rec.visibility });
    }
    case 'metric': {
      // A metric IS a measure on a dataset, so its audience IS the dataset's tier
      // (`tabs/metrics/lib/store.ts` reads `tier: TIER_OF[d.tier]`). There is no metric
      // rung to apply here: the only move that could change a metric's audience is
      // promoting its DATASET — a different artifact, with its own documentation gate and
      // its own physical publish, which an approver must authorise on its own card.
      // Nothing files this shape any more; a request left over from when the Metrics tab
      // did is refused with the REASON instead of dying on "unknown artifactKind", and it
      // stays pending rather than being marked approved with nothing applied.
      const e = new Error(
        "A metric's audience is its dataset's audience — promote the dataset in the Data tab (request_promotion runs the physical publish) and this metric follows. This request cannot be applied.",
      ) as Error & { status?: number };
      e.status = 409;
      throw e;
    }
    case 'connection':
    case 'artifact':
    case 'app': {
      const applier = kind === 'connection' ? deps.promoteConnection : kind === 'artifact' ? deps.promoteArtifact : deps.promoteApp;
      if (!applier) throw new Error(`${kind} ${rung} requires the injected ${kind} applier (not injected)`);
      const full = typeof approver === 'string' ? { id: approver, role: 'builder' as Principal['role'], domains: [a.domain] } : approver;
      const r = await applier(id, full);
      return okResult(r.name, { visibility: r.visibility });
    }
    default:
      throw new Error(`unknown ladder artifactKind: ${kind || '(none)'}`);
  }
}
