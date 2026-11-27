/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { addNotification } from '@core/notifications/store';
import { getUserLocale } from '@core/prefs/locale';
import { serverTextFor } from '@core/i18n/server-text';
import { formattersFor } from '@core/i18n/format';
import type { AlertEvaluation } from '@tabs/metrics/lib/alerts';
import type { Cadence, Channel, ScheduledReport } from '@tabs/dashboards/lib/reports';

/**
 * The REAL delivery boundary for scheduled reports and fired alerts. Previously
 * `sendReport()` only advanced `lastSentAt` and `evaluateAlert()` returned a
 * `notifications[]` that died in the JSON response — nothing was ever sent. This wires
 * the pure decision to actual delivery:
 *
 * ALERTS, DATA-QUALITY alerts AND scheduled REPORTS all land as an in-app notification —
 * in-app is the ONE delivery surface (email/Slack were UI fiction with no real path). The
 * recipient reads it via the notification bell (GET /api/notifications). Never a silent no-op.
 *
 * The `userId` is resolved by the route from the authenticated principal (their own inbox),
 * so a send always has an owner. Governance (who may trigger a send) is enforced at the
 * route, before this is called.
 *
 * LANGUAGE (i18n wave 4): the title and body are written once, at send time, in the RECIPIENT's saved
 * language (`getUserLocale`, `serverTextFor` over `server.notify.*`) — never the sender's. English is
 * byte-identical to before; the posted time stays ISO in every language, and the alert's own `note.message`
 * (written by the alert rule) is passed through unchanged.
 */

export type DeliveryChannel = 'in_app';
export type DeliveryResult = {
  channel: DeliveryChannel;
  delivered: boolean;
  /** The user id (in_app) the message went to. */
  to: string;
  /** The stored in-app notification id. */
  notificationId?: string;
};

function deliver(
  recipient: { userId: string; email?: string },
  kind: 'report' | 'alert',
  title: string,
  bodyLines: string[],
): DeliveryResult {
  // In-app is the only channel: a durable, readable notification (never a silent drop).
  const n = addNotification({ userId: recipient.userId, kind, title, body: bodyLines.join('\n') });
  return { channel: 'in_app', delivered: true, to: recipient.userId, notificationId: n.id };
}

/** Deliver a scheduled-report snapshot notice to its recipient. */
export async function deliverReport(
  report: Pick<ScheduledReport, 'dashboardId' | 'cadence' | 'channel'>,
  recipient: { userId: string; email?: string },
  sentAt: number,
): Promise<DeliveryResult> {
  // Says only what happened: a notice was posted. No snapshot is attached and no schedule
  // exists (report-honesty.test.ts), so the text claims neither.
  void report.cadence;
  const text = serverTextFor(await getUserLocale(recipient.userId));
  const dashboard = report.dashboardId;
  const at = new Date(sentAt).toISOString();
  const title = text('notify.report.title', { dashboard }, `Report notice: ${dashboard}`);
  const bodyLines = [
    text('notify.report.body', { dashboard }, `A notice for dashboard "${dashboard}" was posted by hand. Open the dashboard to see its current data.`),
    text('notify.report.posted', { at }, `Posted ${at} in-app.`),
  ];
  return deliver(recipient, 'report', title, bodyLines);
}

/** Deliver an alert breach's notifications to the recipient (one message per channel). */
export async function deliverAlert(
  evaluation: AlertEvaluation,
  member: string,
  recipient: { userId: string; email?: string },
): Promise<DeliveryResult[]> {
  if (!evaluation.breached || evaluation.notifications.length === 0) return [];
  const results: DeliveryResult[] = [];
  const locale = await getUserLocale(recipient.userId);
  const text = serverTextFor(locale);
  // English keeps the raw number exactly as before; other languages get their own number format.
  const value = locale === 'en' ? String(evaluation.value) : formattersFor(locale).number(evaluation.value);
  for (const note of evaluation.notifications) {
    const title = text('notify.alert.title', { member }, `Alert fired: ${member}`);
    const bodyLines = [note.message, text('notify.alert.value', { value }, `Current value: ${evaluation.value}.`)];
    results.push(await deliver(recipient, 'alert', title, bodyLines));
  }
  return results;
}

/**
 * Deliver a DATA-QUALITY failure notice to its recipient (the dataset owner).
 *
 * It MOVED to `@core/notifications/dq-alert` (B4-review L-2): its new caller is the Data tab's
 * Dagster asset-check read-back, and a tab may not import another tab. Re-exported here so this
 * module remains the one place a reader looks for "what the OS delivers".
 */
export { deliverDqAlert } from '@core/notifications/dq-alert';
export type { DqDeliveryResult } from '@core/notifications/dq-alert';

// Re-exported so the route/tests don't need to reach across modules for the types.
export type { Cadence, Channel };
