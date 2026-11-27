/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       dashboards
 * FEATURE:    The words the report panel uses, in one testable place
 * USER STORY: As a dashboard builder I want the report panel to describe exactly what its one
 *             button does, so I do not wait for a scheduled report that nothing will send.
 * ARCHITECTURE:
 *   - A `.ts` sibling of `ui/Reports.tsx` (a test cannot import a `.tsx`).
 *   - True today: the button posts ONE in-app notification naming the dashboard. No schedule is
 *     saved, no scheduler runs, and no snapshot is attached.
 *   - i18n: the panel renders `REPORT_COPY_KEYS` through the `dashboards` catalog; `REPORT_COPY` stays
 *     the English text (the honesty test proves the English catalog renders it identically).
 */
export const REPORT_COPY = {
  title: 'Report notice',
  intro: 'Post a one-line notice naming this dashboard to your in-app notifications.',
  schedulingUnavailable:
    'Scheduling is not available yet: no cadence is saved and nothing is sent automatically. No snapshot is attached.',
  button: 'Post notice now',
  posted: 'Posted to your in-app notifications',
} as const;

/** The `dashboards.*` catalog keys of the report panel's words (the UI renders these). */
export const REPORT_COPY_KEYS = {
  title: 'report.title',
  heading: 'report.heading',
  intro: 'report.intro',
  schedulingUnavailable: 'report.schedulingUnavailable',
  button: 'report.button',
  posted: 'report.posted',
  postedLine: 'report.postedLine',
} as const;
