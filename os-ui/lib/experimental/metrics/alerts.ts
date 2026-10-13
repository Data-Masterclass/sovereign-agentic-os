/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { measureMember } from './model.ts';
import type { Dataset, Measure } from '../data/index.ts';

/**
 * Alerts on governed metrics. An alert sets a THRESHOLD on a metric member; on breach it
 * NOTIFIES (in-app) AND can TRIGGER a governed agent — an event → a LangGraph
 * run (Langfuse-traced). An alert evaluates the SAME member the explorer/dashboard/agent
 * resolve, through the SAME governed-SQL path (exploreMetric — Cube is off the read path,
 * Phase 2), AS the rule's OWNER, so it fires on exactly the number that owner sees. The
 * headless value resolution + honest 'unavailable'/'pending' skip live in build/alert-eval.ts.
 * Alerts belong with Metrics (a threshold on a metric), not Dashboards.
 *
 * Pure: {@link evaluateAlert} decides; the live wiring (notify, enqueue the agent run) is
 * injected at the route. Modelled so the kind-gate "an alert notifies AND triggers an
 * agent run" is exercised deterministically.
 */

export type Comparator = 'lt' | 'lte' | 'gt' | 'gte';
/** In-app is the only alert channel — email/Slack were UI fiction (no delivery path).
 *  Legacy persisted rules carrying 'email'/'slack' are coerced to 'in_app' on load. */
export type Channel = 'in_app';

export type AlertRule = {
  id: string;
  /** The governed metric member the threshold is on. */
  member: string;
  comparator: Comparator;
  threshold: number;
  /** Delivery channels — always ['in_app']. Kept as an array for storage compat. */
  notify: Channel[];
  /** Optional: a governed agent to trigger on breach (event → LangGraph run). */
  triggerAgent?: { systemId: string; agent: string; preset: string };
};

/**
 * Coerce a rule's persisted `notify` to the only supported channel. Legacy rules may carry
 * 'email'/'slack' (former UI fiction — no delivery path ever existed for them); those collapse
 * to 'in_app'. Always returns exactly ['in_app'] so old rules keep firing, never crash.
 */
export function coerceChannels(_notify?: unknown): Channel[] {
  return ['in_app'];
}

/** Build an alert on a defined metric (so the member is always the canonical one). */
export function alertOn(
  dataset: Dataset,
  measure: Measure,
  opts: { id: string; comparator: Comparator; threshold: number; notify?: readonly string[]; triggerAgent?: AlertRule['triggerAgent'] },
): AlertRule {
  return { id: opts.id, member: measureMember(dataset, measure), comparator: opts.comparator, threshold: opts.threshold, notify: coerceChannels(opts.notify), triggerAgent: opts.triggerAgent };
}

function breaches(value: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
  }
}

export type Notification = { channel: Channel; message: string };
/** The governed run an alert requests on breach (Langfuse-traced when executed). */
export type AgentRunRequest = { systemId: string; agent: string; preset: string; reason: string; traced: true };

export type AlertEvaluation = {
  breached: boolean;
  value: number;
  notifications: Notification[];
  agentRun: AgentRunRequest | null;
};

/**
 * Evaluate an alert against the metric's current value. No breach → nothing fires. On
 * breach → one notification per channel AND (if configured) a governed agent-run request
 * carrying the reason. The request is `traced: true` because every alert-triggered run is
 * a governed event the route hands to the agent runtime + Langfuse.
 */
export function evaluateAlert(rule: AlertRule, value: number): AlertEvaluation {
  const breached = breaches(value, rule.comparator, rule.threshold);
  if (!breached) return { breached: false, value, notifications: [], agentRun: null };
  const reason = `${rule.member} = ${value} ${rule.comparator} ${rule.threshold}`;
  // Coerce so a legacy rule persisted with 'email'/'slack' still fires exactly one in-app note.
  const notifications = coerceChannels(rule.notify).map((channel) => ({ channel, message: `Alert: ${reason}` }));
  const agentRun: AgentRunRequest | null = rule.triggerAgent
    ? { systemId: rule.triggerAgent.systemId, agent: rule.triggerAgent.agent, preset: rule.triggerAgent.preset, reason, traced: true }
    : null;
  return { breached: true, value, notifications, agentRun };
}
