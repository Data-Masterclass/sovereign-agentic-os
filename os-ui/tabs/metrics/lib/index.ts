/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metrics tab public API barrel
 * USER STORY: As a developer in another tab or route I want one import for metric store operations and
 *             schema types, so that I do not depend on the tab's internal file layout.
 * ARCHITECTURE:
 *   - Re-exports `./store` (server-only list/get) and `./schema` (model and explorer).
 *   - Not the only entry point in practice: many routes and MCP tools still import deep paths such as
 *     `@tabs/metrics/lib/build/explore-server`.
 */
// Store ops: list/get metrics (server-only).
export * from '@tabs/metrics/lib/store';

// Metric schema types (MetricForm, GuidedFilter, GuidedWindow, Granularity, etc.).
export * from '@tabs/metrics/lib/schema';
