/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    POST /api/runtime/run-grants/<id>/finish (WP-15; ../../_handlers.ts holds the run checks).
 * USER STORY: As a data owner I want Dagster runs to act as me only inside a checked run grant.
 * ARCHITECTURE: The caller is a Dagster pod's ServiceAccount (TokenReview), and OPA decides
 *   `run_grant_finish` for it (chart seed grant) before anything changes. Off: 404.
 */
import { config } from '@core/kernel/config';
import { authorize } from '@core/infra/governed';
import { finish, forbidden, notFound, reviewCaller } from '../../_handlers';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!config.dagsterRunGrants) return notFound();
  const who = await reviewCaller(req, config.runGrantFinishSubject);
  if (!who.ok) return who.res;
  const authz = await authorize(who.username, 'run_grant_finish');
  if (!authz.allowed) return forbidden(authz.policy);
  return finish(req, ctx);
}
