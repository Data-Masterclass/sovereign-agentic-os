/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import type { CurrentUser } from '@/lib/auth';
import type { Scope } from './types';
import { deriveScope } from './scope-core';

/**
 * The server-side half of the OPA-scoping spine: resolve the viewer's read scope
 * from their Ory identity (role + domains), with a best-effort OPA cross-check.
 * The PURE predicates (`canSee`/`filterScope`/`assertInScope`) live in
 * `scope-core.ts` so the security invariants are unit-testable without IO.
 *
 *   • user    — own runs / cost / artifacts          → item.owner === principal
 *   • builder — their domains                         → item.domain ∈ domains
 *   • admin   — tenant + cluster (incl. node/heal)    → everything
 *
 * The hard invariant (validation gate): a User MUST NOT open another user's
 * trace — enforced by `assertInScope` (re-exported below) on the drill route.
 */

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
export { canSee, filterScope, assertInScope, deriveScope } from './scope-core';
