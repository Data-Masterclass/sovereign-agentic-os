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
import { config } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import type { Scope } from '@tabs/monitoring/lib/types';
import { deriveScope } from '@tabs/monitoring/lib/scope-core';

export async function scopeForUser(user: CurrentUser): Promise<Scope> {
  const via = (await opaConfirms(user.id)) ? 'opa' : 'identity';
  return deriveScope(user.role, user.id, user.domains, via);
}

/** Best-effort OPA confirmation that the principal may read Monitoring. */
async function opaConfirms(principal: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${config.opaUrl}/v1/data/agentic/authz/allow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { principal, tool: 'monitoring_read' } }),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { result?: unknown };
    return Boolean(data?.result);
  } catch {
    // OPA off locally — identity mapping governs; marked via:'identity'.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Re-export the pure predicates so app code has one import surface (`./scope`).
export { canSee, filterScope, assertInScope, deriveScope } from '@tabs/monitoring/lib/scope-core';
