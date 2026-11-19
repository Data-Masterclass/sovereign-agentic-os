/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring library barrel — the read/observe plane's public surface
 * USER STORY: As a developer wiring a Monitoring route or MCP tool I want one import for the
 *             overview, correlation, scope and trace functions so that callers do not reach
 *             into internals.
 * ARCHITECTURE:
 *   - Re-exports `types`, `buildOverview` / `collectAll`, `correlate`, the scope predicates and
 *     `fetchTrace`.
 *   - Imported by the `/api/monitoring` routes, `app/api/platform-admin/components/route.ts`
 *     and `core/mcp/monitoring-tools.ts`. Architecture notes: `tabs/monitoring/lib/README.md`.
 */
export * from '@tabs/monitoring/lib/types';
export { buildOverview, collectAll } from '@tabs/monitoring/lib/aggregate';
export { correlate } from '@tabs/monitoring/lib/correlate';
export { scopeForUser, canSee, filterScope, assertInScope } from '@tabs/monitoring/lib/scope';
export { fetchTrace } from '@tabs/monitoring/lib/adapters/run-trace';
