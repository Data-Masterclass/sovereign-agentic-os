/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring scope resolution — the viewer's read scope from their identity
 * USER STORY: As a user I want Monitoring to work out what I may see from my role and domains
 *             so that every lens and the trace drill-down obey the same rule.
 * ARCHITECTURE:
 *   - Server-only. `scopeForUser` derives the scope from the identity (role + domains) via
 *     `deriveScope`; a best-effort OPA call (1.5 s timeout) only sets the `via` marker to
 *     'opa' or 'identity' and does not change the scope.
 *   - Re-exports the pure predicates from `scope-core.ts` so callers have one import.
 *   - `assertInScope` on the trace route stops a user opening another user's trace.
 */
import 'server-only';
import { opaQuery } from '@core/adapters/opa/client';
import type { CurrentUser } from '@core/kernel/auth';
import type { Scope } from '@tabs/monitoring/lib/types';
import { deriveScope } from '@tabs/monitoring/lib/scope-core';

export async function scopeForUser(user: CurrentUser): Promise<Scope> {
  const via = (await opaConfirms(user.id)) ? 'opa' : 'identity';
  return deriveScope(user.role, user.id, user.domains, via);
}

/** Best-effort OPA confirmation that the principal may read Monitoring. */
async function opaConfirms(principal: string): Promise<boolean> {
  // OPA off locally (unreachable) — identity mapping governs; marked via:'identity'.
  const r = await opaQuery('agentic/authz/allow', { principal, tool: 'monitoring_read' }, 1500);
  return r.ok && r.value.defined && Boolean(r.value.value);
}

// Re-export the pure predicates so app code has one import surface (`./scope`).
export { canSee, filterScope, assertInScope, deriveScope } from '@tabs/monitoring/lib/scope-core';
