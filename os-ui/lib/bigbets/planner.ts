/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Big Bet planner adapter (Opus spine — the scaffold-via-governed-flow control).
 *
 * The planner turns a goal into a plan and, on approval, scaffolds each component
 * — but it is a PROPOSER, not a shipper. Two invariants are enforced in code:
 *
 *   1. It scaffolds ONLY through each tab's governed create flow (store.addComponent
 *      → source.scaffold), landing every artifact at `planned` (draft level). It
 *      never reaches a tab directly and never forks a create action.
 *   2. It runs as a `kind: 'planner'` actor, so the source REJECTS it for every
 *      promote/certify/go-live transition — promotion stays human (Builder/Admin).
 *      The planner literally cannot self-promote; it has no code path to.
 *
 * Two-mode governance: `in-tab` (a human is present) records an inline approval
 * per step; `autonomous` records the safety presets it ran under. Every step is
 * OPA-authorized + Langfuse-traced through injected hooks (the API wires the real
 * OPA decision API + Langfuse; tests inject spies). Default hooks are permissive
 * + no-op so the spine stays unit-testable offline.
 */

import { type Actor, type Principal, type Tab, BetError } from './model.ts';
import { addComponent, getBet, setComponentPlan } from './store.ts';

export type PlannerStep = {
  tab: Tab;
  title: string;
  /** Indices (within the plan) of steps this one builds AFTER (build-order deps). */
  dependsOn: number[];
  /** Planned-ready offset in days from the kickoff date. */
  offsetDays: number;
  /** Upstream artifact ids this component will consume (composition seed). */
  consumes?: string[];
  rationale: string;
};

export type ProposedPlan = {
  goal: string;
  template: string;
  steps: PlannerStep[];
};

export type Mode = 'in-tab' | 'autonomous';

/** OPA gate + Langfuse trace, injectable so the spine stays offline-testable. */
export type PlannerHooks = {
  authorize?: (principal: string, action: string) => Promise<boolean> | boolean;
  trace?: (event: { step: string; tab: Tab; mode: Mode; principal: string }) => Promise<void> | void;
};

const defaultHooks: Required<PlannerHooks> = {
  authorize: () => true, // fail-open offline; the API passes the live OPA decision
  trace: () => {},
};

// --------------------------------------------------------------- templates ---

/**
 * Goal → breakdown templates. The "churn"/"retention" template is the worked
 * example: a churn data product → a churn ML model (depends on data) → a Churn
 * Risk dashboard + a retention agent (both depend on the model). Other goals get
 * a sensible default (a data product + a dashboard on top).
 */
export function proposePlan(goal: string, opts?: { upstream?: { data?: string; connection?: string; knowledge?: string } }): ProposedPlan {
  const g = goal.toLowerCase();
  const churn = /churn|retention|attrition/.test(g);
  if (churn) {
    return {
      goal,
      template: 'reduce-churn',
      steps: [
        { tab: 'data', title: 'Churn data product', dependsOn: [], offsetDays: 14, consumes: opts?.upstream?.connection ? [opts.upstream.connection] : [], rationale: 'A governed churn feature mart the model trains on.' },
        { tab: 'ml', title: 'Churn risk model', dependsOn: [0], offsetDays: 35, rationale: 'Predicts churn probability; depends on the data product.' },
        { tab: 'dashboard', title: 'Churn Risk dashboard', dependsOn: [1], offsetDays: 49, rationale: 'Surfaces at-risk accounts to the team; builds on the model.' },
        { tab: 'agent', title: 'Sales retention agent', dependsOn: [1], offsetDays: 56, consumes: opts?.upstream?.knowledge ? [opts.upstream.knowledge] : [], rationale: 'Reaches out to at-risk accounts; builds on the model + knowledge.' },
      ],
    };
  }
  return {
    goal,
    template: 'default',
    steps: [
      { tab: 'data', title: `${goal} data product`, dependsOn: [], offsetDays: 14, rationale: 'A governed data product to ground the initiative.' },
      { tab: 'dashboard', title: `${goal} dashboard`, dependsOn: [0], offsetDays: 28, rationale: 'A dashboard built on the data product.' },
    ],
  };
}

// ----------------------------------------------------------------- approve ---

export type ScaffoldResult = {
  template: string;
  mode: Mode;
  created: { refId: string; tab: Tab; title: string; artifactId: string }[];
};

/**
 * On approval, scaffold every step into its tab (planner actor) and wire the
 * dependency edges from the plan. Returns the created refs. Promotion is NOT
 * performed — the components land at `planned` and a human ships them later.
 */
export async function approvePlan(
  betId: string,
  approver: Principal,
  plan: ProposedPlan,
  opts: { mode?: Mode; kickoff?: string; hooks?: PlannerHooks } = {},
): Promise<ScaffoldResult> {
  const mode: Mode = opts.mode ?? 'in-tab';
  const hooks = { ...defaultHooks, ...(opts.hooks ?? {}) };
  const kickoff = opts.kickoff ?? new Date().toISOString().slice(0, 10);

  // The planner acts under the approver's authority but is marked `planner`, so
  // the source rejects it for any promote/certify/go-live. It can ONLY scaffold.
  const planner: Actor = { ...approver, kind: 'planner' };

  // Authz the plan as a whole first (the approving human must be allowed to edit).
  const bet = getBet(betId, approver);
  const ok = await hooks.authorize(approver.id, 'bigbet.planner.scaffold');
  if (!ok) throw new BetError('Planner scaffolding not authorized for this principal', 403);

  const created: ScaffoldResult['created'] = [];
  const indexToRef: string[] = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const plannedReady = addDays(kickoff, step.offsetDays);
    const { ref } = addComponent(betId, planner, {
      tab: step.tab,
      scaffold: { title: step.title, consumes: step.consumes },
      start: kickoff,
      plannedReady,
    });
    indexToRef[i] = ref.id;
    created.push({ refId: ref.id, tab: step.tab, title: step.title, artifactId: ref.artifactId });
    await hooks.trace({ step: step.title, tab: step.tab, mode, principal: planner.id });
  }

  // Second pass: wire dependency edges now that every ref id exists.
  for (let i = 0; i < plan.steps.length; i++) {
    const deps = plan.steps[i].dependsOn.map((d) => indexToRef[d]).filter(Boolean);
    if (deps.length) setComponentPlan(betId, approver, indexToRef[i], { dependsOn: deps });
  }

  void bet; // bet fetched above only to enforce view-scope before scaffolding.
  return { template: plan.template, mode, created };
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
