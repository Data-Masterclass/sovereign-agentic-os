/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { runtimeTokenOk } from '@tabs/agents/lib/build/runtime-auth';
import { backupInventory } from '@core/infra/git-backup';
import { config, runtimeBearerAuthAllowed } from '@core/kernel/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/git/backup-inventory → `{ repos: [{ key, refs: { "refs/heads/main": "<oid>", … } }] }`.
 * The LIVE side of the WP-56 restore drill: every bare repository under the repos root with every
 * ref, read from the repository itself. Service-only: the drill CronJob presents the shared
 * runtime bearer; there is no user path (a user reads history through the governed git routes).
 * Fail-closed exactly like /api/data/projects: with the dev placeholder token the bearer is refused.
 */
export async function GET(req: Request) {
  if (!runtimeBearerAuthAllowed() || !runtimeTokenOk(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'service bearer required' }, { status: 401 });
  }
  return NextResponse.json(await backupInventory(config.reposDir));
}
