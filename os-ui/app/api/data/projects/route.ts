/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@tabs/data/lib/server';
import { runtimeTokenOk } from '@tabs/agents/lib/build/runtime-auth';
import { resolveOwner } from '@tabs/agents/lib/build/scheduled';
import { projectIndex } from '@tabs/data/lib/dbt/read';
import { config } from '@core/kernel/config';

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
 * SKIP: bearer-OR-user auth at top, not a single gate.
 */
export async function GET(req: Request) {
  const isActive = async (id: string) => (await resolveOwner(id)) !== null;
  if (runtimeTokenOk(req.headers.get('authorization'))) {
    return NextResponse.json(await projectIndex(isActive, { reposDir: config.reposDir }));
  }
  try {
    const user = await requirePrincipal();
    return NextResponse.json(await projectIndex(isActive, { reposDir: config.reposDir, domains: user.domains }));
  } catch (e) {
    return errorResponse(e);
  }
}
