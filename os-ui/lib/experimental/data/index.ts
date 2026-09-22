/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Data — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 * Deep-path imports remain valid for client components that must avoid
 * the `server-only` surfaces re-exported below.
 */

// Store ops: list/get/create/reassign datasets (server-only).
export * from './store.ts';

// Dataset schema types (Layer, Dataset, Grant, ColumnDoc, etc.).
export * from './schema.ts';

// OpenMetadata client — the governed catalog's system-of-record probe/pull.
export * from './openmetadata.ts';

// -----------------------------------------------------------------------------
// Cross-tab shared surface (ARCHITECTURE.md contract).
//
// The Metrics + Dashboards tabs are built ON TOP of Data's Cube/Gold + identity +
// transparency primitives. Rather than let them reach into `lib/data/*` internals
// (a contract violation), the SPECIFIC symbols they consume are surfaced here so
// they import the data tab through its barrel like every other consumer. These are
// isomorphic (no `server-only`), matching the store/schema re-exports above.
// -----------------------------------------------------------------------------

// Cube/Gold model helpers (data/metrics.ts) — measure kinds, Cube view/name,
// Gold mart FQN, view members, SQL-readiness, YAML scaffold, dimension typing.
export {
  MEASURE_TYPES,
  slug,
  cubeName,
  cubeViewName,
  goldMartFqn,
  viewMembers,
  metricSqlReady,
  scaffoldCubeYaml,
  inferDimType,
} from './metrics.ts';
export type { MeasureType, CubeDimType } from './metrics.ts';

// Delegated-identity primitives (data/identity.ts) — the governed token the
// Metrics/Dashboards query path delegates + propagates to Cube/Trino.
export { claimsFromUser, delegate, propagate } from './identity.ts';
export type { DelegatedToken } from './identity.ts';

// Transparency gate (data/transparency.ts) — the same documentation gate the
// Metrics consistency check enforces before a metric may go live.
export { transparencyGate, gateReason } from './transparency.ts';
