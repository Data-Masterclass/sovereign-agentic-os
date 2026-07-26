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
 * (two viewers, different rows). SECURITY (M1): a client-supplied region must NEVER
 * seed a real RLS security context for an ordinary user — that would let any signed-in
 * user impersonate another region on the live Cube/Trino path. So the body-supplied
 * region is honored ONLY for an admin (the deliberate "view as" affordance); for every
 * other role it is ignored and the region derives from the session identity alone
 * (today the mock session carries none — exactly as production behaves before the Ory
 * JWT supplies a region claim). When the real IdP lands, region comes from the JWT, not
 * the request body, for all roles.
 */
export async function delegatedToken(
  scope: AgentScope,
  opts: { region?: string } = {},
): Promise<{ token: DelegatedToken; user: CurrentUser }> {
  const user = await requireUser();
  // Only an admin may override the viewed region from the request body (view-as demo).
  const region = user.role === 'admin' ? opts.region : undefined;
  const attributes: Record<string, string> = region ? { region } : {};
  const claims = claimsFromUser({ id: user.id, domains: user.domains, role: user.role, attributes });
  return { token: delegate(claims, scope), user };
}
