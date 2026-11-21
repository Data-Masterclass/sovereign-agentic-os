/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Dagster run grants: issue, check at run start, activate, finish, revoke (WP-15)
 * USER STORY: As a data owner I want my scheduled and ad-hoc data runs to act as me in Trino only
 *             when the OS has checked, at the moment the run starts, that the run is exactly the
 *             one my grant allows, that the grant is live and that I still have access.
 * ARCHITECTURE:
 *   - Durable source: `os_governance.run_grants` (WP-07; `active_until` from migration 4). Kinds:
 *     `dataset` = one launch the OS makes (Build, transform, gold join, Sync now), bound to its
 *     commit and asset selection, one-shot; `standing` = one per (domain, dataset, principal,
 *     schedule), the id written into `os/schedules.yml`, valid across commits.
 *   - Dagster OSS has no users, so a run's tags prove nothing on their own: /start reads the run
 *     back from Dagster's GraphQL by its id and compares it with the grant (`verifyRun`, pure).
 *   - Activation is a row update. The statement trigger moves `grant_revision.rev` in the same
 *     transaction, so the revision returned is the one the os-grants bundle must reach before the
 *     run may query (the caller waits on OPA's own status report, 10 F3).
 *   - The Trino OPA rule (policies/trino_impersonation.rego) lets `svc-dagster-runner` act for a
 *     grant's principal only while `active_run_id` is set and `active_until` is in the future.
 *   - Nothing here throws into a route for a refusal: refusals are typed results.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '@core/adapters/postgres/pool';
import { selectionHash, standingGrantId } from '@core/policy/run-grant-ids';

export { selectionHash, standingGrantId };

export type RunGrantKind = 'run' | 'standing' | 'dataset';

export type RunGrantRow = {
  id: string;
  kind: RunGrantKind;
  principal_uid: string;
  domain: string;
  dataset: string | null;
  selection_hash: string | null;
  commit: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  active_run_id: string | null;
  active_until: Date | null;
  /** `dagster-job:<name>` binds a standing grant to its schedule's job (and so its selection). */
  scopes: string[];
};

/** What /start compares: the run as DAGSTER reports it, never as the caller describes it. */
export type RunView = {
  runId: string;
  status: string;
  jobName: string;
  tags: Record<string, string>;
  /** Asset keys, path segments joined with `/`. */
  assetSelection: string[];
};

/** A missed /finish closes a standing grant's window by itself after this long (10 F4). */
export const ACTIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** A launched (dataset) grant must be used soon after it is issued. */
export const DATASET_GRANT_TTL_MS = 60 * 60 * 1000;
/** A standing grant lives as long as its schedule; re-issued (and so renewed) on every commit. */
export const STANDING_GRANT_TTL_MS = 400 * 24 * 60 * 60 * 1000;

const RUNNING = new Set(['STARTING', 'STARTED']);

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Is `run` (read from Dagster) exactly what `grant` allows, now? Pure. Every mismatch is an
 * "unauthorised launch": the run pod fails before any Trino query.
 */
export function verifyRun(grant: RunGrantRow, run: RunView, now: Date, commitKnown?: (sha: string) => boolean): Verdict {
  const no = (reason: string): Verdict => ({ ok: false, reason });
  if (grant.kind === 'run') return no('an agent run grant cannot start a Dagster run');
  if (grant.revoked_at) return no('the grant is revoked');
  if (grant.expires_at.getTime() <= now.getTime()) return no('the grant has expired');
  if (!RUNNING.has(run.status)) return no(`the run is ${run.status}, not starting`);
  const t = run.tags;
  if (t['os/run_grant'] !== grant.id) return no('the run does not carry this grant');
  if (t['os/principal'] !== grant.principal_uid) return no('the run names another principal than the grant');
  if (t['os/domain'] !== grant.domain) return no('the run is for another domain than the grant');
  if (grant.dataset && t['os/dataset'] !== grant.dataset) return no('the run is for another dataset than the grant');
  if (grant.kind === 'dataset') {
    if (!grant.commit || t['os/commit'] !== grant.commit) return no('the run pins another commit than the grant');
    if (!grant.selection_hash || selectionHash(run.assetSelection) !== grant.selection_hash) return no('the run selects other assets than the grant');
  } else {
    // A standing grant spans commits; the commit must still be one the OS wrote on the domain.
    const sha = t['os/commit'] ?? '';
    if (!/^[0-9a-f]{40}$/.test(sha)) return no('the run pins no commit');
    if (commitKnown && !commitKnown(sha)) return no('the run pins a commit that is not on the domain repository');
    if (!t['os/schedule']) return no('a standing grant starts scheduled runs only');
    const job = grant.scopes.find((x) => x.startsWith('dagster-job:'))?.slice('dagster-job:'.length);
    if (job && (run.jobName !== job || t['os/schedule'] !== job)) return no('the run is another job than the grant\'s schedule');
  }
  return { ok: true };
}

const COLS = 'id, kind, principal_uid, domain, dataset, selection_hash, commit, expires_at, revoked_at, active_run_id, active_until, scopes';

export async function getRunGrant(pool: pg.Pool, id: string): Promise<RunGrantRow | null> {
  const r = await pool.query<RunGrantRow>(`SELECT ${COLS} FROM os_governance.run_grants WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** One launch the OS makes: bound to its commit and its selection, valid for an hour. */
export async function issueDatasetGrant(pool: pg.Pool, g: {
  principal: string; domain: string; dataset: string; commit: string; selection: (string[] | string)[]; issuedBy: string; ttlMs?: number;
}): Promise<string> {
  const id = `rg_ds_${randomBytes(12).toString('hex')}`;
  await pool.query(
    `INSERT INTO os_governance.run_grants (id, kind, principal_uid, domain, dataset, selection_hash, commit, issued_by, expires_at)
     VALUES ($1, 'dataset', $2, $3, $4, $5, $6, $7, pg_catalog.clock_timestamp() + $8 * interval '1 millisecond')`,
    [id, g.principal, g.domain, g.dataset, selectionHash(g.selection), g.commit, g.issuedBy, g.ttlMs ?? DATASET_GRANT_TTL_MS],
  );
  return id;
}

/** `job`: the schedule's Dagster job name (the grant is bound to it, and so to its selection). */
export type StandingEntry = { dataset: string; principal: string; schedule: string; enabled: boolean; job?: string };

/**
 * Make the domain's standing grants equal its ENABLED schedules: upsert one per entry (renewing
 * its expiry) and revoke every other standing grant of the domain (sync disabled, owner changed,
 * dataset gone). Returns the ids by schedule name.
 */
export async function reconcileStandingGrants(pool: pg.Pool, domain: string, entries: StandingEntry[], issuedBy: string): Promise<Record<string, string>> {
  const want = entries.filter((e) => e.enabled).map((e) => ({ ...e, id: standingGrantId(domain, e.dataset, e.principal, e.schedule) }));
  return withTransaction(pool, async (c) => {
    for (const e of want) {
      await c.query(
        `INSERT INTO os_governance.run_grants (id, kind, principal_uid, domain, dataset, scopes, issued_by, expires_at)
         VALUES ($1, 'standing', $2, $3, $4, $7::text[], $5, pg_catalog.clock_timestamp() + $6 * interval '1 millisecond')
         ON CONFLICT (id) DO UPDATE SET revoked_at = NULL, expires_at = EXCLUDED.expires_at, scopes = EXCLUDED.scopes
           WHERE os_governance.run_grants.revoked_at IS NOT NULL
              OR os_governance.run_grants.scopes IS DISTINCT FROM EXCLUDED.scopes
              OR os_governance.run_grants.expires_at < pg_catalog.clock_timestamp() + interval '30 days'`,
        [e.id, e.principal, domain, e.dataset, issuedBy, STANDING_GRANT_TTL_MS, e.job ? [`dagster-job:${e.job}`] : []],
      );
    }
    await c.query(
      `UPDATE os_governance.run_grants SET revoked_at = pg_catalog.clock_timestamp(), active_run_id = NULL, active_until = NULL
        WHERE domain = $1 AND kind = 'standing' AND revoked_at IS NULL AND NOT (id = ANY($2::text[]))`,
      [domain, want.map((e) => e.id)],
    );
    return Object.fromEntries(want.map((e) => [e.schedule, e.id]));
  });
}

export async function revokeRunGrant(pool: pg.Pool, id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE os_governance.run_grants SET revoked_at = pg_catalog.clock_timestamp(), active_run_id = NULL, active_until = NULL
      WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The end of a run's activation window. A run's further steps re-check the grant but never move the
 * window: one run gets at most ACTIVE_WINDOW_MS from its first activation, and never past the grant.
 */
export function activeUntil(row: Pick<RunGrantRow, 'active_run_id' | 'active_until' | 'expires_at'>, runId: string, now: Date): Date {
  if (row.active_run_id === runId && row.active_until) return row.active_until;
  return new Date(Math.min(now.getTime() + ACTIVE_WINDOW_MS, row.expires_at.getTime()));
}

export type Activation =
  | { ok: true; rev: string; principal: string; activeUntil: string }
  | { ok: false; code: 'not_found' | 'unauthorised_launch' | 'grant_in_use'; reason: string };

/**
 * Activate `id` for `run`, atomically: lock the row, re-check it against the run (the row may have
 * changed since the caller read it), set `active_run_id` + `active_until`, and return the grant
 * revision that carries the activation. A different live run already holding a standing grant is
 * refused (the run coordinator's tag limit makes that unreachable; this is the second line).
 */
export async function activateRunGrant(pool: pg.Pool, id: string, run: RunView, now: () => Date, commitKnown?: (sha: string) => boolean): Promise<Activation> {
  return withTransaction(pool, async (c) => {
    const row = (await c.query<RunGrantRow>(`SELECT ${COLS} FROM os_governance.run_grants WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) return { ok: false, code: 'not_found', reason: `no run grant ${id}` };
    const v = verifyRun(row, run, now(), commitKnown);
    if (!v.ok) return { ok: false, code: 'unauthorised_launch', reason: v.reason };
    const t = now().getTime();
    if (row.active_run_id && row.active_run_id !== run.runId && row.active_until && row.active_until.getTime() > t) {
      return { ok: false, code: 'grant_in_use', reason: `the grant is active for run ${row.active_run_id}` };
    }
    if (row.kind === 'dataset' && row.active_run_id && row.active_run_id !== run.runId) {
      return { ok: false, code: 'unauthorised_launch', reason: 'a launched grant starts one run only' };
    }
    const until = activeUntil(row, run.runId, now());
    await c.query(`UPDATE os_governance.run_grants SET active_run_id = $2, active_until = $3 WHERE id = $1`, [id, run.runId, until]);
    const rev = (await c.query<{ rev: string }>('SELECT rev::text AS rev FROM os_governance.grant_revision WHERE id = 1')).rows[0].rev;
    return { ok: true, rev, principal: row.principal_uid, activeUntil: until.toISOString() };
  });
}

/**
 * End the activation of `id` by `runId` (idempotent). A launched (dataset) grant is one-shot, so
 * it is revoked; a standing grant waits for its schedule's next tick. Returns the new revision, or
 * null when the grant was not active for that run.
 */
export async function finishRunGrant(pool: pg.Pool, id: string, runId: string): Promise<string | null> {
  return withTransaction(pool, async (c) => {
    const r = await c.query(
      `UPDATE os_governance.run_grants
          SET active_run_id = NULL, active_until = NULL,
              revoked_at = CASE WHEN kind = 'dataset' THEN pg_catalog.clock_timestamp() ELSE revoked_at END
        WHERE id = $1 AND active_run_id = $2`,
      [id, runId],
    );
    if ((r.rowCount ?? 0) === 0) return null;
    return (await c.query<{ rev: string }>('SELECT rev::text AS rev FROM os_governance.grant_revision WHERE id = 1')).rows[0].rev;
  });
}
