/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The status words Monitoring prints — a raw enum value from the panels API to its catalog key
 * USER STORY: As a German operator I want "fail", "degraded" or "requires_approval" in a badge to read in my
 *             language, while the API and the MCP tools keep returning the same English enum values.
 * ARCHITECTURE:
 *   - Pure, no React. The panels payload carries raw enum values (`fail`, `not_run`, `FAILURE`, `critical`,
 *     `requires_approval` …); the UI used to print them as they came. `statusKey(raw)` maps a KNOWN value
 *     (exact, lowercase — a caller that printed `FAILURE` lower-cased keeps doing so; an upper-case word is not
 *     matched, so its English stays as it was) to `monitoring.status.<key>`, whose English text is exactly the word printed before;
 *     an unknown value returns null and the UI prints it verbatim (a new upstream state is never hidden).
 *   - Used by PanelsView, DetailView and the Monitoring page through a three-line hook in each component.
 */

export const STATUS_KEYS = {
  ok: 'ok', warn: 'warn', error: 'error',
  pass: 'pass', passed: 'passed', fail: 'fail', failed: 'failed', not_run: 'notRun', unavailable: 'unavailable',
  ready: 'ready', degraded: 'degraded', down: 'down',
  success: 'success', failure: 'failure', started: 'started', starting: 'starting', queued: 'queued',
  canceled: 'canceled', canceling: 'canceling', not_started: 'notStarted', running: 'running', superseded: 'superseded',
  green: 'green', amber: 'amber', red: 'red', grey: 'grey',
  critical: 'critical', warning: 'warning', info: 'info',
  allow: 'allow', deny: 'deny', requires_approval: 'requiresApproval',
  draft: 'draft', live: 'live', notified: 'notified',
  done: 'done', held: 'held', active: 'active', other: 'other',
  pending: 'pending', approved: 'approved', rejected: 'rejected', none: 'none',
  manual: 'manual', scheduled: 'scheduled', schedule: 'schedule',
} as const;

export type StatusKey = (typeof STATUS_KEYS)[keyof typeof STATUS_KEYS];

/** The catalog key under `monitoring.status.` for a raw status word, or null when the word is not a known one. */
export function statusKey(raw: string | null | undefined): StatusKey | null {
  if (typeof raw !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(STATUS_KEYS, raw) ? STATUS_KEYS[raw as keyof typeof STATUS_KEYS] : null;
}
