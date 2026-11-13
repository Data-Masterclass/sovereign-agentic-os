/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@tabs/data/lib/server';
import { runtimeTokenOk } from '@tabs/agents/lib/build/runtime-auth';
import { resolveOwner } from '@tabs/agents/lib/build/scheduled';
import { projectIndex } from '@tabs/data/lib/dbt/read';
import { config, runtimeBearerAuthAllowed } from '@core/kernel/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/data/projects → `{ domains: [{ name, head, principals: [{ id, active }] }] }` — the repo
 * INDEX (engine rebuild B2, closes B1-8: the git protocol cannot enumerate repositories).
 *
 * Two callers, two auths (both governed):
 *   • the Dagster `repo-sync` sidecar and the `os_principals` sensor present the shared runtime
 *     bearer (cluster-internal, same contract as the sync trigger) → every domain repository;
 *   • a signed-in user → only the domains they belong to.
 * `active` is the OS's live view of each schedule principal (the dataset owner): resolved through
 * the same owner resolver scheduled runs use — a deactivated / deleted owner is `active:false`, and
 * the sensor pauses that owner's schedules rather than running them (concept §6).
 *
 * FAIL-CLOSED (review B2-review-M3): the bearer half is only honoured when the deployment actually
 * configured `AGENT_RUNTIME_TOKEN`. With the shipped dev placeholder still in place, a production
 * runtime refuses the bearer outright (401) rather than handing the whole cross-domain index to
 * anyone who can read this repository; a signed-in user is still served, narrowed to their domains.
 * `runtimeTokenOk` itself is NOT changed — five other routes share it, two of them WRITE paths
 * outside this phase's scope, so the gate is tightened here where the un-narrowed read lives.
 *
 * SKIP: bearer-OR-user auth at top, not a single gate.
 */
export async function GET(req: Request) {
  const isActive = async (id: string) => (await resolveOwner(id)) !== null;
  const authHeader = req.headers.get('authorization');
  if (authHeader && !runtimeBearerAuthAllowed()) {
    return NextResponse.json(
      { error: 'runtime bearer auth is disabled: AGENT_RUNTIME_TOKEN is unset or still the shipped dev default' },
      { status: 401 },
    );
  }
  if (runtimeBearerAuthAllowed() && runtimeTokenOk(authHeader)) {
    return NextResponse.json(await projectIndex(isActive, { reposDir: config.reposDir }));
  }
  try {
    const user = await requirePrincipal();
    return NextResponse.json(await projectIndex(isActive, { reposDir: config.reposDir, domains: user.domains }));
  } catch (e) {
    return errorResponse(e);
  }
}
