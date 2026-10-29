/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Scheduled reports on governed dashboards. A report sends a dashboard snapshot on a
 * cadence — delivered in-app (the ONE delivery surface). Pure: this decides which reports
 * are DUE and records a send; the live wiring (render the PDF, deliver) is injected at the
 * route (lib/dashboards/delivery).
 *
 * (Metric ALERTS moved to lib/metrics/alerts.ts — a threshold on a metric belongs with
 * Metrics; reports, which snapshot a dashboard, stay here with Dashboards.)
 */

/** In-app is the only delivery channel (email/Slack were UI fiction, no real path). */
export type Channel = 'in_app';
export type Cadence = 'daily' | 'weekly' | 'monthly';

/**
 * Coerce a report config's persisted `channel` to the only supported one. Legacy configs
 * (from a client cache or older store) may carry 'email'/'slack'; collapse them to 'in_app'
 * so an old report keeps delivering, never crashes on legacy data.
 */
export function coerceChannel(_channel?: unknown): Channel {
  return 'in_app';
}

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
  // Coerce so a config with a legacy 'email'/'slack' channel still delivers in-app.
  const channel = coerceChannel(report.channel);
  return {
    report: { ...report, channel, lastSentAt: now },
    send: { reportId: report.id, dashboardId: report.dashboardId, channel, sentAt: now },
  };
}
