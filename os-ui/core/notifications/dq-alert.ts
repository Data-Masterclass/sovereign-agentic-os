/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The data-quality failure notice, where both tabs can reach it (B4 review L-2)
 * USER STORY: As a dataset owner I want one in-app notification the first time my dataset's quality
 *             checks fail — sent by whichever surface noticed, not only by a sweep that no longer
 *             exists.
 * ARCHITECTURE:
 *   - `deliverDqAlert` used to live in `tabs/dashboards/lib/delivery.ts`, whose only caller was the
 *     deleted `/api/data/dq/run-all` sweep (deviation B4-9). The new caller is the Data tab's
 *     Dagster asset-check read-back, and a tab may not import another tab — so the function moved
 *     HERE, beside `addNotification`, which is all it ever used. `tabs/dashboards/lib/delivery.ts`
 *     re-exports it so its own vocabulary is unchanged.
 *   - In-app is the ONE channel (e-mail/Slack were UI fiction with no real path); a delivery is a
 *     durable notification the recipient reads through the bell, never a silent drop.
 */
import 'server-only';
import { addNotification } from '@core/notifications/store';

export type DqDeliveryResult = {
  channel: 'in_app';
  delivered: boolean;
  /** The user id the message went to. */
  to: string;
  /** The stored in-app notification id. */
  notificationId?: string;
};

/**
 * Deliver a DATA-QUALITY failure notice to its recipient (the dataset owner). The caller decides
 * WHETHER to send — `isNewFailure` plus a persisted last-alerted record — so this function is a
 * pure delivery boundary and never suppresses anything of its own.
 */
export function deliverDqAlert(
  input: { datasetName: string; healthScore: number | null; failingLabels: string[] },
  recipient: { userId: string; email?: string },
): DqDeliveryResult {
  const title = `Data quality alert: ${input.datasetName}`;
  const bodyLines = [
    `Quality checks failed for "${input.datasetName}".`,
    input.healthScore !== null ? `Health score: ${input.healthScore}/100.` : 'Health score: unknown.',
    input.failingLabels.length ? `Failing: ${input.failingLabels.join(', ')}.` : '',
  ].filter(Boolean);
  const n = addNotification({ userId: recipient.userId, kind: 'alert', title, body: bodyLines.join('\n') });
  return { channel: 'in_app', delivered: true, to: recipient.userId, notificationId: n.id };
}
