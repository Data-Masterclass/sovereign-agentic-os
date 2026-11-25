/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    How a connection test result reads in the UI
 * USER STORY: As a user I want a check that could not run yet ("connect your account first") to look
 *             neutral, not like a failure, and a real failure to say what to do.
 * ARCHITECTURE:
 *   - Pure, client-safe. `ConnectionBuilder.tsx` shows this line; the leading mark drives the style
 *     (✗ = error box, ✓ / ○ = neutral answer box).
 *   - `state` comes from `testConnection` (`verified` / `failed` / `not_verified`); results without it
 *     keep the old ✓ / ✗ on `ok`.
 */

export type TestPayload = { ok?: unknown; state?: unknown; detail?: unknown; error?: unknown; hint?: unknown };

export function testMessage(d: TestPayload): string {
  const detail = typeof d.detail === 'string' ? d.detail : typeof d.error === 'string' ? d.error : '';
  const hint = typeof d.hint === 'string' && d.hint ? ` ${d.hint}` : '';
  if (d.state === 'not_verified') return `○ ${detail.replace(/^Not verified yet:\s*/i, 'Not verified yet: ')}${hint}`;
  if (d.ok === true || d.state === 'verified') return `✓ ${detail}`;
  return `✗ ${detail}${hint}`;
}
