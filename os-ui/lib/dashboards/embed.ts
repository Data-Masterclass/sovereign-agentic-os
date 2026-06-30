/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type DelegatedToken, propagate } from '../data/identity.ts';

/**
 * Tiles → double-click → embed. The one integration detail that must be right (R3):
 * when a dashboard opens inline, our backend mints a Superset GUEST TOKEN with the
 * VIEWER'S row-level security baked into the token (`rls: [{ clause }]`), and the
 * Embedded SDK renders it in an iframe (~5-min token + refresh).
 *
 * The RLS clause is derived from the SAME delegated identity the explorer + the agent
 * use ({@link propagate} → securityContext), so the embedded dashboard, the metric
 * explorer and the agent `metrics` tool all filter to the identical rows. Crucially the
 * guest token is per-VIEWER, never a shared service identity — two viewers get two
 * different clauses (proven in the tests). A non-delegated token is refused so RLS
 * cannot collapse to a superuser.
 *
 * Pure: the actual JWT signing + the Superset `POST /security/guest_token` call live in
 * build/live-clients; here we build the REQUEST (resource + rls + user + ttl), which is
 * what carries the security guarantee.
 */

export const GUEST_TOKEN_TTL_SECONDS = 300; // ~5 minutes, then refresh (Superset default)

export type RlsRule = {
  /** The Superset RLS WHERE clause for this viewer (applied on the dataset). */
  clause: string;
  /** The dataset(s) the rule applies to; empty ⇒ all datasets in the embed. */
  dataset?: string;
};

export type GuestTokenRequest = {
  /** The embedded dashboard's UUID. */
  resourceId: string;
  resourceType: 'dashboard';
  /** A non-PII user descriptor for Superset's audit (the delegated subject). */
  user: { username: string };
  /** The viewer's RLS — the security guarantee (R3): the rows they may see. */
  rls: RlsRule[];
  /** Seconds-to-live; the SDK refreshes before expiry. */
  ttlSeconds: number;
};

/**
 * Turn a Cube security context into a Superset RLS clause. Low-cardinality attributes
 * (region, tenant, …) become equality predicates; the owning domain scopes the rest.
 * High-cardinality entitlements resolve via an entitlement-table join (mirrors the
 * policy compiler R1) rather than an inlined IN-list. This is the SAME filter the Cube
 * security context applies, expressed for Superset's own RLS layer so the two agree.
 */
export function rlsFromSecurityContext(ctx: Record<string, unknown>): RlsRule[] {
  const rules: RlsRule[] = [];
  const ATTR_KEYS = ['region', 'tenant', 'country', 'unit'];
  for (const k of ATTR_KEYS) {
    const v = ctx[k];
    if (typeof v === 'string' && v) rules.push({ clause: `${k} = '${sqlEscape(v)}'` });
  }
  // No low-card attribute → fall back to the entitlement-table join on the subject
  // (high-cardinality, R1) so the viewer is never accidentally unfiltered.
  if (rules.length === 0 && typeof ctx.sub === 'string' && ctx.sub) {
    rules.push({ clause: `region IN (SELECT region FROM entitlements WHERE principal = '${sqlEscape(ctx.sub)}')` });
  }
  return rules;
}

function sqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Build the guest-token request for a viewer opening a dashboard. R3: derives the RLS
 * from the viewer's delegated token (propagate asserts it's user-bound — refuses a
 * service account), so the embed is scoped to the viewer, not to whoever Superset
 * connects to Cube as.
 */
export function guestTokenRequest(token: DelegatedToken, dashboardId: string): GuestTokenRequest {
  const { cube } = propagate(token); // throws if not user-delegated (R3 guard)
  return {
    resourceId: dashboardId,
    resourceType: 'dashboard',
    user: { username: token.sub },
    rls: rlsFromSecurityContext(cube.securityContext),
    ttlSeconds: GUEST_TOKEN_TTL_SECONDS,
  };
}
