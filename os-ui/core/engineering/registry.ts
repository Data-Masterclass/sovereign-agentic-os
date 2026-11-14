/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view
 * FEATURE:    The adapter registry — `kind` → the tab's `lib/engineering.ts` adapter
 * USER STORY: As a maintainer I want ONE place that knows which object kinds have an engineering
 *             view, so the panel and the MCP tool cannot disagree and a new kind is one
 *             registration rather than a second renderer (plan D25).
 * ARCHITECTURE:
 *   - Same shape as `core/mcp/registry.ts`: a process-wide map a tab fills, deduped by kind, so
 *     the KERNEL NEVER IMPORTS A TAB. The loading side lives in `core/engineering/register.ts`,
 *     which uses dynamic `import()` exactly as `core/mcp/register-experimental.ts` does.
 *   - No I/O here, and no React: the whole module is testable with a stub adapter.
 */
import { ENGINEERING_KINDS, type EngineeringAdapter, type EngineeringKind } from '@core/engineering/types';

const adapters = new Map<EngineeringKind, EngineeringAdapter>();

/** Register one kind's adapter. First registration wins (a second is a no-op, as with hot reload). */
export function registerEngineeringAdapter(kind: EngineeringKind, adapter: EngineeringAdapter): void {
  if (adapters.has(kind)) return;
  adapters.set(kind, adapter);
}

/** The adapter for a kind, or null when its tab is not loaded / not enabled. */
export function engineeringAdapter(kind: EngineeringKind): EngineeringAdapter | null {
  return adapters.get(kind) ?? null;
}

/** The kinds that have an adapter right now, in the declared order of `ENGINEERING_KINDS`. */
export function registeredEngineeringKinds(): EngineeringKind[] {
  return ENGINEERING_KINDS.filter((k) => adapters.has(k));
}

/** Test seam: drop a registration so a test can assert the "no adapter" path. */
export function __unregisterEngineeringAdapterForTests(kind: EngineeringKind): void {
  adapters.delete(kind);
}
