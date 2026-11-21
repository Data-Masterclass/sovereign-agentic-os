/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The run-grant start and finish handlers Dagster calls (WP-15; 01 R1–R3, 10 F3/F4)
 * USER STORY: As a data owner I want a Dagster run to act as me only after the OS has checked, by
 *             asking Dagster itself, that the run is the one my grant allows, that I still have
 *             access, and that Trino's OPA already holds the activation — and to fail before its
 *             first query otherwise.
 * ARCHITECTURE:
 *   - Caller identity: the pod's projected ServiceAccount token (audience `os-ui`), checked by the
 *     API server (TokenReview). /start accepts only the run pods' SA (`dagster-run`), /finish only
 *     the code server's SA (`dagster-code`, the run-status sensor). No shared bearer.
 *   - The run is READ BACK from Dagster GraphQL by id (`core/infra/dagster.ts run()`); the caller's
 *     body names only the run id.
 *   - Access at start: the principal is an active OS user who is still in the grant's domain (or a
 *     tenant admin). Otherwise the grant is revoked and the run refused.
 *   - Proof, not time (10 F3): after the activation commits, wait until every OPA instance in
 *     `runGrantOpaInstances` (the Trino sidecar) reports the os-grants revision that carries it.
 *     A timeout undoes the activation and answers `grant_not_propagated`.
 *   - Off (`OS_DAGSTER_RUN_GRANTS` unset): 404, as if the routes did not exist.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { governanceRuntimePool } from '@core/adapters/postgres/pool';
import { bearerOf, reviewToken } from '@core/infra/tokenreview';
import * as dagster from '@core/infra/dagster';
import { commitExists } from '@core/infra/git-store';
import { waitForBundleRevision } from '@core/policy/opa-status';
import { activateRunGrant, finishRunGrant, getRunGrant, revokeRunGrant, type RunView } from '@core/policy/run-grants';
import { listUsers } from '@tabs/admin/lib/users';

type Ctx = { params: Promise<{ id: string }> };
const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

async function caller(req: Request, want: string): Promise<Response | null> {
  if (!want) return json(503, { error: 'not_configured', reason: 'the accepted ServiceAccount is not configured' });
  const r = await reviewToken(bearerOf(req), config.runGrantAudience);
  if (!r.ok) return json(r.status, { error: 'unauthenticated', reason: r.reason });
  if (r.username !== want) return json(403, { error: 'forbidden', reason: 'this ServiceAccount may not call this route' });
  return null;
}

async function runId(req: Request): Promise<string | null> {
  try {
    const b = (await req.json()) as { run_id?: unknown };
    return typeof b.run_id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(b.run_id) ? b.run_id : null;
  } catch {
    return null;
  }
}

async function principalAccess(uid: string, domain: string): Promise<string | null> {
  const u = (await listUsers()).find((x) => x.id === uid);
  if (!u) return `${uid} is not an OS user`;
  if (u.disabled) return `${uid} is deactivated`;
  if (u.role !== 'admin' && !u.domains.includes(domain)) return `${uid} is no longer a member of ${domain}`;
  return null;
}

export async function start(req: Request, ctx: Ctx): Promise<Response> {
  if (!config.dagsterRunGrants) return json(404, { error: 'not_found' });
  const denied = await caller(req, config.runGrantStartSubject);
  if (denied) return denied;
  const { id } = await ctx.params;
  const rid = await runId(req);
  if (!rid) return json(400, { error: 'bad_request', reason: 'body must be {"run_id": "<dagster run id>"}' });
  const pool = governanceRuntimePool();
  const grant = await getRunGrant(pool, id);
  if (!grant) return json(404, { error: 'unauthorised_launch', reason: `no run grant ${id}` });
  const read = await dagster.run(rid);
  if (!read.ok) return json(403, { error: 'unauthorised_launch', reason: `Dagster does not know run ${rid}: ${read.error}` });
  const run: RunView = { runId: read.data.runId, status: read.data.status, jobName: read.data.jobName, tags: read.data.tags, assetSelection: read.data.assetSelection };
  const lost = await principalAccess(grant.principal_uid, grant.domain);
  if (lost) {
    await revokeRunGrant(pool, id);
    return json(403, { error: 'unauthorised_launch', reason: `the owner lost access: ${lost}` });
  }
  const sha = run.tags['os/commit'] ?? '';
  const known = grant.kind === 'standing' && /^[0-9a-f]{40}$/.test(sha) ? await commitExists(grant.domain, sha).catch(() => false) : false;
  const act = await activateRunGrant(pool, id, run, () => new Date(), () => known);
  if (!act.ok) return json(act.code === 'grant_in_use' ? 409 : 403, { error: act.code, reason: act.reason });
  const seen = await waitForBundleRevision('os-grants', act.rev, config.runGrantOpaInstances, 10_000);
  if (!seen.ok) {
    await finishRunGrant(pool, id, rid);
    return json(503, { error: seen.code, reason: seen.detail });
  }
  return json(200, { principal: act.principal, grant_rev: act.rev, active_until: act.activeUntil, propagated_ms: seen.ms });
}

export async function finish(req: Request, ctx: Ctx): Promise<Response> {
  if (!config.dagsterRunGrants) return json(404, { error: 'not_found' });
  const denied = await caller(req, config.runGrantFinishSubject);
  if (denied) return denied;
  const { id } = await ctx.params;
  const rid = await runId(req);
  if (!rid) return json(400, { error: 'bad_request', reason: 'body must be {"run_id": "<dagster run id>"}' });
  // Only a run Dagster reports as finished may end its activation (a forged early /finish would
  // only shorten the owner's own run, but there is no reason to accept it).
  const read = await dagster.run(rid);
  if (!read.ok) return json(404, { error: 'not_found', reason: read.error });
  if (!['SUCCESS', 'FAILURE', 'CANCELED'].includes(read.data.status)) return json(409, { error: 'run_not_finished', reason: read.data.status });
  const rev = await finishRunGrant(governanceRuntimePool(), id, rid);
  return json(200, { finished: rev !== null, grant_rev: rev });
}
