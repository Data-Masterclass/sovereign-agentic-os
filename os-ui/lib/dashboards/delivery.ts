/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { mailerConfigured, sendNotificationEmail } from '../mailer.ts';
import { addNotification } from '../notifications/store.ts';
import type { AlertEvaluation, Cadence, Channel, ScheduledReport } from './alerts.ts';

/**
 * The REAL delivery boundary for scheduled reports and fired alerts. Previously
 * `sendReport()` only advanced `lastSentAt` and `evaluateAlert()` returned a
 * `notifications[]` that died in the JSON response — nothing was ever sent. This wires
 * the pure decision to actual delivery:
 *
 *   1. If a mailer is configured AND we have a recipient email → send the email.
 *   2. Otherwise → persist an in-app notification the recipient can read back
 *      (GET /api/notifications). Never a silent no-op.
 *
 * The email `to` is resolved by the route from the authenticated principal (their own
 * inbox), so a send always has an owner. Governance (who may trigger a send) is enforced
 * at the route, before this is called.
 */

export type DeliveryChannel = 'email' | 'in_app';
export type DeliveryResult = {
  channel: DeliveryChannel;
  delivered: boolean;
  /** Email address (email) or user id (in_app) the message went to. */
  to: string;
  /** Set when it landed as an in-app notification. */
  notificationId?: string;
};

async function deliver(
  recipient: { userId: string; email?: string },
  kind: 'report' | 'alert',
  title: string,
  bodyLines: string[],
): Promise<DeliveryResult> {
  if (recipient.email && mailerConfigured()) {
    const ok = await sendNotificationEmail(recipient.email, title, bodyLines);
    if (ok) return { channel: 'email', delivered: true, to: recipient.email };
  }
  // Fallback: a durable, readable in-app notification (never a silent drop).
  const n = addNotification({ userId: recipient.userId, kind, title, body: bodyLines.join('\n') });
  return { channel: 'in_app', delivered: true, to: recipient.userId, notificationId: n.id };
}

/** Deliver a scheduled-report snapshot notice to its recipient. */
export async function deliverReport(
  report: Pick<ScheduledReport, 'dashboardId' | 'cadence' | 'channel'>,
  recipient: { userId: string; email?: string },
  sentAt: number,
): Promise<DeliveryResult> {
  const title = `Scheduled report: ${report.dashboardId}`;
  const bodyLines = [
    `Your ${report.cadence} snapshot of dashboard "${report.dashboardId}" is ready.`,
    `Delivered ${new Date(sentAt).toISOString()} on the ${report.channel} channel.`,
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
  for (const note of evaluation.notifications) {
    const title = `Alert fired: ${member}`;
    const bodyLines = [note.message, `Current value: ${evaluation.value}.`, `Requested channel: ${note.channel}.`];
    results.push(await deliver(recipient, 'alert', title, bodyLines));
  }
  return results;
}

// Re-exported so the route/tests don't need to reach across modules for the types.
export type { Cadence, Channel };
