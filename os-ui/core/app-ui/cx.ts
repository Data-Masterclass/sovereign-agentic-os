/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    cx — a tiny className joiner for the app-ui package
 * USER STORY: As a maintainer of the app-ui package I want one helper to join class names so that
 *             the components need no third-party dependency.
 * ARCHITECTURE:
 *   - Used by every component in `core/app-ui/` and re-exported from `index.ts`.
 *   - Drops falsy values and joins the rest with a space.
 */

/** Tiny className joiner — drops falsy values, trims. No dependency. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
