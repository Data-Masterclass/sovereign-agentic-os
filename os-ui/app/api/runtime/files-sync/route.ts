/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    POST /api/runtime/files-sync — the scheduled Drive-sync pass (./_handlers.ts holds the work).
 * USER STORY: As a drive owner I want my drive synced on a schedule by Dagster, as me.
 * ARCHITECTURE: The caller is the Dagster run pod's ServiceAccount (TokenReview, the same identity the
 *   run-grant start uses), and OPA decides `files_sync_run` for it (chart seed grant) before anything runs.
 */
import { authorize } from '@core/infra/governed';
import { config } from '@core/kernel/config';
import { forbidden, reviewCaller } from '../run-grants/_handlers';
import { principalById } from '@core/kernel/auth';
import { resolveConnectionAccessToken } from '@tabs/connections/lib/index';
import { tickWith } from './_handlers';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const who = await reviewCaller(req, config.runGrantStartSubject);
  if (!who.ok) return who.res;
  const authz = await authorize(who.username, 'files_sync_run');
  if (!authz.allowed) return forbidden(authz.policy);
  return tickWith((src) => ({
    liveOwner: principalById,
    token: async () => (src.connectionId ? resolveConnectionAccessToken(src.connectionId, src.owner) : null),
  }));
}
