/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The `os-grants` OPA bundle: run grants and their approved writes, from Postgres,
 *             served with HTTP long polling so a grant change reaches OPA in well under 2 s.
 * USER STORY: As a user starting an agent or data run I want the grant the run acts under to be
 *             in OPA (and in Trino's OPA) before the run starts, and to stay there across restarts.
 * ARCHITECTURE:
 *   - Durable source: `os_governance.run_grants` + `run_grant_approved_writes` (WP-07 schema).
 *     The bundle revision is `os_governance.grant_revision.rev`, which a statement trigger moves
 *     on every grant-bearing write in the same transaction (10 F3). One REPEATABLE READ, READ ONLY
 *     transaction reads the revision and the rows together, so the bytes always match the revision.
 *   - Content: `os_grants.run_grants[id] = {kind, principal_uid, domain, system_id, dataset,
 *     scopes, expires_at, active_run_id, approved_writes[]}` for every grant not revoked. Expiry is
 *     time, not a revision, so consumers compare `expires_at` themselves (Rego `time.now_ns()`).
 *   - Long polling (https://www.openpolicyagent.org/docs/management-bundles#http-long-polling):
 *     OPA sends `If-None-Match` and `Prefer: wait=<s>`; the route holds the request until the
 *     revision moves or the wait ends (304), and answers with
 *     `Content-Type: application/vnd.openpolicyagent.bundles` to say it supports long polling.
 *   - A database that cannot be read is a 503, never an empty grant set: OPA keeps its last good
 *     (persisted) bundle.
 */
import type pg from 'pg';
import { governancePool, withTransaction } from '@core/adapters/postgres/pool';
import { config } from '@core/kernel/config';
import { buildBundle, type OpaBundle } from '@core/policy/bundle';

export const OS_GRANTS_ROOTS = ['os_grants'] as const;
export const BUNDLE_CONTENT_TYPE = 'application/vnd.openpolicyagent.bundles';

type GrantRow = {
  id: string; kind: string; principal_uid: string; domain: string; system_id: string | null; dataset: string | null;
  scopes: string[]; expires_at: Date; active_run_id: string | null;
};
type WriteRow = { grant_id: string; table_fqn: string; op: string; approval_id: string; expires_at: Date };

export function grantsPool(): pg.Pool {
  const url = config.governanceDatabaseUrl;
  if (!url) throw new Error('OS_GOVERNANCE_DATABASE_URL is not set — the os-grants bundle has no source');
  return governancePool(url);
}

export async function grantRevision(pool: pg.Pool = grantsPool()): Promise<string> {
  const r = await pool.query<{ rev: string }>('SELECT rev::text AS rev FROM os_governance.grant_revision WHERE id = 1');
  if (r.rows.length !== 1) throw new Error('os_governance.grant_revision has no row');
  return r.rows[0].rev;
}

/** Compile the os-grants bundle from one consistent snapshot. Throws on any database error. */
export async function compileOsGrants(pool: pg.Pool = grantsPool()): Promise<OpaBundle> {
  return withTransaction(pool, async (c) => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const rev = (await c.query<{ rev: string }>('SELECT rev::text AS rev FROM os_governance.grant_revision WHERE id = 1')).rows[0]?.rev;
    if (rev === undefined) throw new Error('os_governance.grant_revision has no row');
    const grants = (await c.query<GrantRow>(
      `SELECT id, kind, principal_uid, domain, system_id, dataset, scopes, expires_at, active_run_id
         FROM os_governance.run_grants WHERE revoked_at IS NULL ORDER BY id`,
    )).rows;
    const writes = (await c.query<WriteRow>(
      `SELECT w.grant_id, w.table_fqn, w.op, w.approval_id, w.expires_at
         FROM os_governance.run_grant_approved_writes w
         JOIN os_governance.run_grants g ON g.id = w.grant_id AND g.revoked_at IS NULL
        ORDER BY w.grant_id, w.table_fqn, w.op`,
    )).rows;
    const run_grants: Record<string, unknown> = {};
    for (const g of grants) {
      run_grants[g.id] = {
        kind: g.kind, principal_uid: g.principal_uid, domain: g.domain, system_id: g.system_id, dataset: g.dataset,
        scopes: [...g.scopes].sort(), expires_at: g.expires_at.toISOString(), active_run_id: g.active_run_id,
        approved_writes: [] as unknown[],
      };
    }
    for (const w of writes) {
      (run_grants[w.grant_id] as { approved_writes: unknown[] }).approved_writes.push({
        table_fqn: w.table_fqn, op: w.op, approval_id: w.approval_id, expires_at: w.expires_at.toISOString(),
      });
    }
    return buildBundle('os-grants', { os_grants: { run_grants } }, OS_GRANTS_ROOTS, rev);
  });
}

// ---------------------------------------------------------------- serve + long poll --

type State = { last: OpaBundle | null; watching: Promise<void> | null; waiters: Set<() => void>; rev: string | null };
const KEY = Symbol.for('soa.policy.os-grants-bundle');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { last: null, watching: null, waiters: new Set(), rev: null });
}

/** The bundle at the current revision (recompiled only when the revision moved). */
export async function currentOsGrantsBundle(pool: pg.Pool = grantsPool()): Promise<OpaBundle> {
  const s = st();
  const rev = await grantRevision(pool);
  if (s.last?.revision === rev) return s.last;
  const b = await compileOsGrants(pool);
  s.last = b;
  return b;
}

const WATCH_MS = 50;
/** One shared poller of the revision row while any long-poll request is waiting. */
function watch(pool: pg.Pool): void {
  const s = st();
  if (s.watching) return;
  s.watching = (async () => {
    while (s.waiters.size > 0) {
      try {
        const rev = await grantRevision(pool);
        if (rev !== s.rev) {
          s.rev = rev;
          for (const w of [...s.waiters]) w();
        }
      } catch {
        // A read failure wakes nobody; the waiting request answers 304 at its deadline and OPA
        // keeps its active bundle. The next request surfaces the error as a 503.
      }
      await new Promise((r) => setTimeout(r, WATCH_MS));
    }
  })().finally(() => {
    s.watching = null;
  });
}

/** Resolve when the revision differs from `etagRev`, or false at the deadline. */
export function waitForGrantChange(etagRev: string, waitMs: number, pool: pg.Pool = grantsPool()): Promise<boolean> {
  const s = st();
  return new Promise((resolve) => {
    const check = () => {
      if (s.rev !== null && s.rev !== etagRev) {
        clearTimeout(timer);
        s.waiters.delete(check);
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      s.waiters.delete(check);
      resolve(false);
    }, waitMs);
    s.waiters.add(check);
    s.rev = null; // force the first watch tick to compare afresh
    watch(pool);
  });
}

/** `Prefer: wait=<seconds>` → milliseconds (capped), or 0. */
export function preferWaitMs(prefer: string | null, capMs = 60_000): number {
  const m = /(?:^|[,;\s])wait=(\d+)/i.exec(prefer ?? '');
  return m ? Math.min(Number(m[1]) * 1000, capMs) : 0;
}

export function __resetOsGrantsBundle(): void {
  const s = st();
  s.last = null;
  s.waiters.clear();
  s.rev = null;
}
