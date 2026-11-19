/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric alert rules — threshold model and pure breach evaluation
 * USER STORY: As a creator I want to set a threshold on a governed metric and be notified in-app when it
 *             is breached, so that I hear about a change without watching a dashboard.
 * ARCHITECTURE:
 *   - Pure: `evaluateAlert` decides breach, notifications and an optional agent-run request; the
 *     routes inject delivery. Value resolution as the rule's owner lives in `./build/alert-eval.ts`.
 *   - In-app is the only channel; legacy `email`/`slack` values are coerced to `in_app`.
 *   - `triggerAgent` only produces an `AgentRunRequest`. No route starts an agent run from it:
 *     `app/api/metrics/alerts/route.ts` records it as a governance trace, and the scheduled
 *     `alerts/run` route ignores it.
 */
import { measureMember } from '@tabs/metrics/lib/model';
import type { Dataset, Measure } from '@tabs/data/lib/index';

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
