/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { measureMember } from '../metrics/model.ts';
import type { Dataset, Measure } from '../data/dataset-schema.ts';

/**
 * Alerts + scheduled reports on governed metrics. An alert sets a THRESHOLD on a metric
 * member; on breach it NOTIFIES (email/Slack/in-app) AND can TRIGGER a governed agent —
 * an event → a LangGraph run (Langfuse-traced). Reports send a dashboard snapshot on a
 * cadence. Both evaluate the SAME member the explorer/dashboard/agent resolve, so an
 * alert fires on the same number a viewer sees.
 *
 * Pure: {@link evaluateAlert} decides; the live wiring (notify, enqueue the agent run,
 * render the PDF) is injected at the route. Modelled so the kind-gate "an alert notifies
 * AND triggers an agent run, a scheduled report sends" is exercised deterministically.
 */

export type Comparator = 'lt' | 'lte' | 'gt' | 'gte';
export type Channel = 'email' | 'slack' | 'in_app';

export type AlertRule = {
  id: string;
  /** The governed metric member the threshold is on. */
  member: string;
  comparator: Comparator;
  threshold: number;
  notify: Channel[];
  /** Optional: a governed agent to trigger on breach (event → LangGraph run). */
  triggerAgent?: { systemId: string; agent: string; preset: string };
};

/** Build an alert on a defined metric (so the member is always the canonical one). */
export function alertOn(
  dataset: Dataset,
  measure: Measure,
  opts: { id: string; comparator: Comparator; threshold: number; notify: Channel[]; triggerAgent?: AlertRule['triggerAgent'] },
): AlertRule {
  return { id: opts.id, member: measureMember(dataset, measure), comparator: opts.comparator, threshold: opts.threshold, notify: opts.notify, triggerAgent: opts.triggerAgent };
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
  const notifications = rule.notify.map((channel) => ({ channel, message: `Alert: ${reason}` }));
  const agentRun: AgentRunRequest | null = rule.triggerAgent
    ? { systemId: rule.triggerAgent.systemId, agent: rule.triggerAgent.agent, preset: rule.triggerAgent.preset, reason, traced: true }
    : null;
  return { breached: true, value, notifications, agentRun };
}

// --------------------------------------------------------------- scheduled reports ---

export type Cadence = 'daily' | 'weekly' | 'monthly';
export type ScheduledReport = {
  id: string;
  dashboardId: string;
  cadence: Cadence;
  channel: Channel;
  /** Epoch ms of the last send (0 = never). */
  lastSentAt: number;
};

const PERIOD_MS: Record<Cadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** Which reports are due to send at `now` (cadence elapsed since the last send). */
export function dueReports(reports: ScheduledReport[], now: number): ScheduledReport[] {
  return reports.filter((r) => now - r.lastSentAt >= PERIOD_MS[r.cadence]);
}

export type ReportSend = { reportId: string; dashboardId: string; channel: Channel; sentAt: number };

/** Mark a report sent (the route renders the snapshot + delivers; this records it). */
export function sendReport(report: ScheduledReport, now: number): { report: ScheduledReport; send: ReportSend } {
  return {
    report: { ...report, lastSentAt: now },
    send: { reportId: report.id, dashboardId: report.dashboardId, channel: report.channel, sentAt: now },
  };
}
