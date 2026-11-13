/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The identity a queued run executes as — re-read live, refused when it changed
 * USER STORY: As a security reviewer I want a job that sat in the queue (or was retried an hour
 *             later by the lease reaper) to execute under the runner's CURRENT identity, and to be
 *             refused — typed and visible — when that identity no longer holds what the run was
 *             filed under: the account gone or disabled, the role downgraded, the domain left.
 * ARCHITECTURE:
 *   - PURE: the directory lookup is injected, so this is unit-tested with no store, session or
 *     database. `build/run-jobs-server.ts` binds `principalById` (the live user directory) to it.
 *   - The queue's form of A2's resume rule (`engine/resume.ts`): the snapshot on the job row is
 *     what WAS true when the run was filed, never the authority.
 */
import type { CurrentUser } from '@core/kernel/auth';
import type { Role } from '@core/kernel/session';
import { roleAtLeast } from '@core/kernel/session';
import type { PrincipalSnapshot } from '@tabs/agents/lib/engine/jobs';

export type RunnerRefusal = { code: 'runner_unavailable' | 'runner_role_changed' | 'runner_domain_lost'; reason: string };
export type HydratedRunner = { user: CurrentUser } | { refused: RunnerRefusal };

/** The live user directory as this module needs it (`core/kernel/auth.ts` `principalById`). */
export type PrincipalLoader = (id: string) => Promise<{ id: string; name: string; role: Role; domains: string[] } | null>;

/** The identity snapshot a job carries (what was true when it was filed — never the authority). */
export function principalSnapshotOf(user: CurrentUser): PrincipalSnapshot {
  return { id: user.id, name: user.name, role: user.role, domains: [...user.allDomains], activeDomain: user.activeDomain };
}

/**
 * Re-read the runner LIVE and decide whether the job may still execute as them. The live role and
 * live domains win; the snapshot is only what the run was FILED under, so a downgrade or a lost
 * domain refuses the job rather than silently running with different authority.
 * A role UPGRADE is not a refusal: the yaml is re-governed against the OWNER's live role on every
 * run (`prepareRunYaml`), so a higher role cannot widen what the system may do.
 */
export async function hydrateRunner(snapshot: PrincipalSnapshot, domain: string, load: PrincipalLoader): Promise<HydratedRunner> {
  const live = await load(snapshot.id);
  if (!live) {
    return { refused: { code: 'runner_unavailable', reason: `the runner '${snapshot.id}' no longer exists or is disabled — the run cannot execute as them` } };
  }
  if (!roleAtLeast(live.role, snapshot.role)) {
    return { refused: { code: 'runner_role_changed', reason: `the runner '${live.id}' is now ${live.role}, below the ${snapshot.role} the run was filed under` } };
  }
  if (domain && !live.domains.includes(domain)) {
    return { refused: { code: 'runner_domain_lost', reason: `the runner '${live.id}' is no longer a member of domain '${domain}'` } };
  }
  const active = snapshot.activeDomain && live.domains.includes(snapshot.activeDomain) ? snapshot.activeDomain : null;
  return {
    user: {
      id: live.id,
      name: live.name,
      role: live.role,
      domains: active ? [active] : live.domains,
      allDomains: live.domains,
      activeDomain: active,
    },
  };
}
