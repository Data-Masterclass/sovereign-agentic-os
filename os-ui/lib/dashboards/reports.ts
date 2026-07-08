/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Scheduled reports on governed dashboards. A report sends a dashboard snapshot on a
 * cadence to a channel. Pure: this decides which reports are DUE and records a send; the
 * live wiring (render the PDF, deliver) is injected at the route (lib/dashboards/delivery).
 *
 * (Metric ALERTS moved to lib/metrics/alerts.ts — a threshold on a metric belongs with
 * Metrics; reports, which snapshot a dashboard, stay here with Dashboards.)
 */

export type Channel = 'email' | 'slack' | 'in_app';
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
