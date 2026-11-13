/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The one FLAG that routes Build to the agentic builder
 * USER STORY: As the operator rolling out a new builder harness I want one switch, default OFF,
 *             so today's behaviour stays byte-identical until I deliberately turn the loop on.
 * ARCHITECTURE:
 *   - PURE (reads `config` only), so the default can be asserted by a test without a server.
 *   - `SOFTWARE_BUILDER` is read in `core/kernel/config.ts` and defaults to `'spec'`. Anything
 *     that is not exactly `'agentic'` means `'spec'` — a typo'd env can never silently enable a
 *     different builder.
 *   - ONE guarded line calls this, in `tabs/software/lib/platform-mcp.ts` `case 'build_software'`.
 */
import { config } from '@core/kernel/config';

/** The two builders. `spec` is today's single-shot AppSpec fill; `agentic` is the bounded loop. */
export type SoftwareBuilderMode = 'spec' | 'agentic';

/** The effective mode. Fail-safe: anything but the exact opt-in string is `spec`. */
export function softwareBuilderMode(): SoftwareBuilderMode {
  return config.softwareBuilder === 'agentic' ? 'agentic' : 'spec';
}

/** The predicate the one guarded line in the build dispatch calls. */
export function agenticBuilderEnabled(): boolean {
  return softwareBuilderMode() === 'agentic';
}
