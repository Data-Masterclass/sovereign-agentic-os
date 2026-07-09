/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { requireUser, type CurrentUser } from '@/lib/core/auth';
import { type AgentScope, type DelegatedToken, claimsFromUser, delegate } from '@/lib/data/identity';

/**
 * The ONE place a route turns the signed-in user into the user-DELEGATED token every
 * governed metric/dashboard call runs under (R2: never a service account; R3: the same
 * identity propagates to Cube/Superset/Trino). Centralized so no route hand-rolls
 * delegation and gets R2/R3 subtly wrong.
 *
 * `region` is an optional demo "view as" affordance for the per-viewer RLS walkthrough
 * (two viewers, different rows). In production the region (and other attributes) come
 * from the Ory JWT claims, not the request body — this only seeds the security context
 * the same way the IdP will.
 */
export async function delegatedToken(
  scope: AgentScope,
  opts: { region?: string } = {},
): Promise<{ token: DelegatedToken; user: CurrentUser }> {
  const user = await requireUser();
  const attributes: Record<string, string> = opts.region ? { region: opts.region } : {};
  const claims = claimsFromUser({ id: user.id, domains: user.domains, role: user.role, attributes });
  return { token: delegate(claims, scope), user };
}
