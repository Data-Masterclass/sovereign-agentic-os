/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
// Pure decision logic (no `server-only`, no value `@/` imports) so it is
// unit-tested with `node --test`; the route wires it to the live ml-agent.

/**
 * The ML agent — guided AutoML under TWO-MODE governance (Opus spine).
 *
 * The opt-in LangGraph ML agent turns plain language ("build a churn model from
 * the sales data") into a plan and can auto-try feature sets + candidate models,
 * then run features → train → deploy-to-Staging. But it NEVER ships: certify,
 * go-live, and promotion are always a human Builder/Admin (enforced both here and
 * in `model-service.ts::assertHuman`). Governance follows the platform's two modes:
 *
 *   • in-tab     (a human is present) → inline approval for ANY write/spend step.
 *   • autonomous (Agent tab)         → bounded by safety presets; GPU within
 *                                       quota; out-of-policy ⇒ blocked + queued
 *                                       to Governance.
 *
 * This module decides; the actual feature/train/deploy execution is the adapters.
 */

export type AgentMode = 'in-tab' | 'autonomous';

/** What a step does to the world — drives whether approval/quota apply. */
export type StepKind = 'read' | 'write' | 'gpu-spend' | 'certify';

export type PlanStep = {
  key: string;
  label: string;
  kind: StepKind;
  /** The adapter that executes it (features / train / deploy …). */
  adapter: 'features' | 'train' | 'registry' | 'deploy' | 'monitoring' | 'governance';
};

/**
 * The default guided-AutoML plan for a churn-style model: explore → features →
 * train → register → deploy-to-Staging. The agent stops at Staging; the last two
 * lifecycle moves (certify, go-live) are deliberately NOT in the agent's plan.
 */
export function proposePlan(goal: string): { goal: string; steps: PlanStep[] } {
  return {
    goal,
    steps: [
      { key: 'explore', label: 'Explore the governed data product', kind: 'read', adapter: 'features' },
      { key: 'features', label: 'Register RFM + tenure features (Featureform)', kind: 'write', adapter: 'features' },
      { key: 'train', label: 'Train + track candidate models (MLflow)', kind: 'write', adapter: 'train' },
      { key: 'register', label: 'Register the best run as a version (MLflow registry)', kind: 'write', adapter: 'registry' },
      { key: 'deploy-staging', label: 'Deploy the best version to Staging (KServe)', kind: 'write', adapter: 'deploy' },
    ],
  };
}

/** Autonomous safety presets — the bounded envelope the agent may act within. */
export type SafetyPreset = 'read-propose' | 'bounded-writes';

export type AgentContext = {
  mode: AgentMode;
  preset?: SafetyPreset; // only meaningful in autonomous mode
  /** Remaining GPU budget for this run, in the same units quotas are set (0 = CPU-only). */
  gpuQuotaRemaining: number;
  /** Whether the step needs GPU (training a large model); CPU default = false. */
};

export type StepDecision = {
  decision: 'allow' | 'requires_approval' | 'blocked';
  reason: string;
};

/**
 * The hard invariant, exposed for the route + tests: an agent can NEVER drive a
 * certify / go-live / promote step, in EITHER mode. The model-service lifecycle
 * functions also reject agent actors; this is the agent-side mirror so the plan
 * never even proposes — and a forged `certify` step is blocked here first.
 */
export function assertAgentCannotCertify(step: PlanStep): void {
  if (step.kind === 'certify' || step.adapter === 'governance') {
    const err = new Error(
      'The ML agent cannot certify, go-live, or promote — those are always a human Builder/Admin',
    );
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}

/**
 * Decide whether the agent may run `step` now, under its mode + presets.
 *   • certify/governance      → blocked, always (the invariant above).
 *   • read                    → allow in both modes.
 *   • write (in-tab)          → requires_approval (inline in the run).
 *   • write (autonomous):
 *        - read-propose       → blocked (queue to Governance: writes not allowed)
 *        - bounded-writes     → allow
 *   • gpu-spend               → allow only if quota remains; else blocked+queued.
 */
export function authorizeAgentStep(step: PlanStep, ctx: AgentContext): StepDecision {
  if (step.kind === 'certify' || step.adapter === 'governance') {
    return {
      decision: 'blocked',
      reason: 'certify / go-live / promote is always a human Builder/Admin — never the agent',
    };
  }

  if (step.kind === 'gpu-spend') {
    if (ctx.gpuQuotaRemaining <= 0) {
      return { decision: 'blocked', reason: 'GPU spend exceeds the quota — queued to Governance for Builder/Admin approval' };
    }
    // GPU is itself a spend: in-tab needs inline approval; autonomous within quota is allowed.
    if (ctx.mode === 'in-tab') {
      return { decision: 'requires_approval', reason: 'GPU spend — inline approval required (human present)' };
    }
    return { decision: 'allow', reason: 'GPU spend within the autonomous quota' };
  }

  if (step.kind === 'read') {
    return { decision: 'allow', reason: 'read / propose — always allowed' };
  }

  // step.kind === 'write'
  if (ctx.mode === 'in-tab') {
    return { decision: 'requires_approval', reason: `${step.label}: a write — inline approval required` };
  }
  // autonomous
  if (ctx.preset === 'read-propose') {
    return { decision: 'blocked', reason: 'autonomous read+propose preset forbids writes — queued to Governance' };
  }
  return { decision: 'allow', reason: `${step.label}: within the autonomous bounded-writes preset` };
}
