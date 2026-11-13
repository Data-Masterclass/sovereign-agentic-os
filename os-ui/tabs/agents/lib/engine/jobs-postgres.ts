/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The `run_jobs` / `run_events` tables in the `agent_runs` database
 * USER STORY: As an operator I want a queued agent run to survive the pod that enqueued it, to be
 *             claimed by exactly ONE worker even with several pods polling, and to leave a durable,
 *             ordered event log any pod can tail — so the Run panel sees the same stream whether the
 *             run executes in the request, in a worker, or across a restart.
 * ARCHITECTURE:
 *   - The Postgres implementation of `jobs.ts`'s `RunJobStore` port, on the SAME database as the
 *     LangGraph checkpointer (`AGENT_RUNS_DATABASE_URL`): one pool per URL, pinned on `globalThis`
 *     (Next dev HMR), `pg` imported lazily so a laptop/test never loads it.
 *   - MIGRATIONS are idempotent DDL (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`)
 *     run once per process from `ensureRunJobsReady()`, called at boot next to the checkpointer's
 *     `setup()` — same contract, no separate init Job.
 *   - CLAIM is `FOR UPDATE SKIP LOCKED` on the oldest `queued` row inside the UPDATE, so two
 *     workers never get the same run and neither blocks on the other.
 *   - A row per run (`run_id` primary key): a `resume` re-queues the SAME row, and the status
 *     column IS the cross-process in-flight lock (`queued`/`running` → `RunJobConflictError`).
 *   - `run_events` is append-only with a per-run `seq` (primary key `(run_id, seq)`), written only
 *     by the lease holder, so a tail is a PK range scan and `seq` is a resume cursor.
 */
import { RunNotVisibleError } from '@tabs/agents/lib/engine/run-visibility';
import {
  boundError,
  isRunEventName,
  RunJobConflictError,
  RunJobNotFoundError,
  type NewRunJob,
  type PrincipalSnapshot,
  type RunEventName,
  type RunEventRow,
  type RunJob,
  type RunJobInput,
  type RunJobKind,
  type RunJobStatus,
  type RunJobStore,
} from '@tabs/agents/lib/engine/jobs';

/** The minimum of `pg.Pool` this module uses — so tests can drive it with a fake. */
export type SqlClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> };

export const RUN_JOBS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_jobs (
     run_id             TEXT PRIMARY KEY,
     system_id          TEXT        NOT NULL,
     domain             TEXT        NOT NULL,
     requested_by       TEXT        NOT NULL,
     principal_snapshot JSONB       NOT NULL,
     input              JSONB       NOT NULL,
     kind               TEXT        NOT NULL,
     status             TEXT        NOT NULL,
     locked_by          TEXT,
     locked_at          TIMESTAMPTZ,
     attempts           INTEGER     NOT NULL DEFAULT 0,
     error              TEXT,
     created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS run_jobs_queued_idx ON run_jobs (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS run_jobs_lease_idx  ON run_jobs (status, locked_at)`,
  `CREATE TABLE IF NOT EXISTS run_events (
     run_id TEXT        NOT NULL,
     seq    INTEGER     NOT NULL,
     event  TEXT        NOT NULL,
     data   JSONB,
     at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (run_id, seq)
   )`,
];

/** Run the idempotent DDL. Safe to call concurrently from several pods. */
export async function migrateRunJobs(sql: SqlClient): Promise<void> {
  for (const stmt of RUN_JOBS_DDL) await sql.query(stmt);
}

function ms(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return new Date(v).getTime();
  return 0;
}

function parseJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
}

function toJob(row: Record<string, unknown>): RunJob {
  return {
    runId: String(row.run_id),
    systemId: String(row.system_id),
    domain: String(row.domain),
    requestedBy: String(row.requested_by),
    principal: parseJson<PrincipalSnapshot>(row.principal_snapshot, { id: '', name: '', role: 'creator', domains: [], activeDomain: null }),
    input: parseJson<RunJobInput>(row.input, { messages: [] }),
    kind: String(row.kind) as RunJobKind,
    status: String(row.status) as RunJobStatus,
    lockedBy: row.locked_by === null || row.locked_by === undefined ? null : String(row.locked_by),
    lockedAt: row.locked_at === null || row.locked_at === undefined ? null : ms(row.locked_at),
    attempts: Number(row.attempts ?? 0),
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
  };
}

function toEvent(row: Record<string, unknown>): RunEventRow {
  const name = String(row.event);
  return {
    runId: String(row.run_id),
    seq: Number(row.seq),
    event: (isRunEventName(name) ? name : 'error') as RunEventName,
    data: parseJson<unknown>(row.data, null),
    at: ms(row.at),
  };
}

const JOB_COLS =
  'run_id, system_id, domain, requested_by, principal_snapshot, input, kind, status, locked_by, locked_at, attempts, error, created_at, updated_at';

/** Postgres-unique-violation — two appends raced for the same `seq`; the loser retries. */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === '23505';
}

/**
 * The Postgres `RunJobStore` over an injected client (a `pg.Pool`, or a fake in tests). The SQL —
 * not the state machine — is what this module adds; the contract is the one `jobs.test.ts` pins
 * against the in-memory store.
 */
export function postgresRunJobStore(sql: SqlClient): RunJobStore {
  const at = (n?: number) => new Date(n ?? Date.now());

  return {
    kind: 'postgres',

    async enqueue(job: NewRunJob, now) {
      const t = at(now);
      // A `start` inserts; anything already queued/running is a conflict. ON CONFLICT DO NOTHING
      // keeps the insert atomic against another pod inserting the same (minted) id.
      if (job.kind === 'start') {
        const ins = await sql.query(
          `INSERT INTO run_jobs (run_id, system_id, domain, requested_by, principal_snapshot, input, kind, status, attempts, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'start','queued',0,$7,$7)
           ON CONFLICT (run_id) DO NOTHING
           RETURNING ${JOB_COLS}`,
          [job.runId, job.systemId, job.domain, job.requestedBy, JSON.stringify(job.principal), JSON.stringify(job.input), t],
        );
        if (ins.rows.length > 0) return toJob(ins.rows[0]);
        const existing = await this.get(job.runId);
        throw new RunJobConflictError(job.runId, existing?.status ?? 'running');
      }
      // A `resume` re-queues the SAME row — only from a settled state (`parked`/`done`/`failed`)
      // and only for the run's OWN requester (A4-review-H-1: the `requested_by` predicate means a
      // foreign resume cannot overwrite `requested_by`/`principal_snapshot` before being refused).
      const upd = await sql.query(
        `UPDATE run_jobs
            SET kind='resume', principal_snapshot=$3::jsonb, input=$4::jsonb,
                status='queued', locked_by=NULL, locked_at=NULL, attempts=0, error=NULL, updated_at=$5
          WHERE run_id=$1 AND requested_by=$2 AND status IN ('parked','done','failed')
          RETURNING ${JOB_COLS}`,
        [job.runId, job.requestedBy, JSON.stringify(job.principal), JSON.stringify(job.input), t],
      );
      if (upd.rows.length > 0) return toJob(upd.rows[0]);
      const existing = await this.get(job.runId);
      if (!existing) throw new RunJobNotFoundError(job.runId);
      if (existing.requestedBy !== job.requestedBy) throw new RunNotVisibleError(job.runId);
      throw new RunJobConflictError(job.runId, existing.status);
    },

    async claim(workerId, now) {
      // FOR UPDATE SKIP LOCKED inside the sub-select: two workers never take the same row and
      // neither waits for the other.
      const res = await sql.query(
        `UPDATE run_jobs j
            SET status='running', locked_by=$1, locked_at=$2, attempts=j.attempts+1, updated_at=$2
          WHERE j.run_id = (
            SELECT run_id FROM run_jobs
             WHERE status='queued'
             ORDER BY created_at, run_id
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
          RETURNING ${JOB_COLS}`,
        [workerId, at(now)],
      );
      return res.rows.length > 0 ? toJob(res.rows[0]) : null;
    },

    async claimById(runId, workerId, now) {
      const res = await sql.query(
        `UPDATE run_jobs
            SET status='running', locked_by=$2, locked_at=$3, attempts=attempts+1, updated_at=$3
          WHERE run_id=$1 AND status='queued'
          RETURNING ${JOB_COLS}`,
        [runId, workerId, at(now)],
      );
      return res.rows.length > 0 ? toJob(res.rows[0]) : null;
    },

    async heartbeat(runId, workerId, now) {
      const res = await sql.query(
        `UPDATE run_jobs SET locked_at=$3, updated_at=$3
          WHERE run_id=$1 AND locked_by=$2 AND status='running'`,
        [runId, workerId, at(now)],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async complete(runId, status, opts) {
      // With `lockedBy` the settle is LEASE-GUARDED (A4-review-H-2): a holder whose lease the
      // reaper took, and whose job another pod has re-claimed, updates nothing.
      const guard = opts?.lockedBy !== undefined ? ` AND locked_by=$5 AND status='running'` : '';
      const values: unknown[] = [runId, status, status === 'failed' ? boundError(opts?.error ?? 'failed') : null, at(opts?.now)];
      if (opts?.lockedBy !== undefined) values.push(opts.lockedBy);
      const res = await sql.query(
        `UPDATE run_jobs SET status=$2, locked_by=NULL, locked_at=NULL, error=$3, updated_at=$4 WHERE run_id=$1${guard}`,
        values,
      );
      return (res.rowCount ?? 0) > 0;
    },

    async requeue(runId, workerId, now) {
      await sql.query(
        `UPDATE run_jobs SET status='queued', kind='resume', locked_by=NULL, locked_at=NULL, updated_at=$3
          WHERE run_id=$1 AND locked_by=$2`,
        [runId, workerId, at(now)],
      );
    },

    async reapStale({ olderThanMs, maxAttempts, now }) {
      const cutoff = new Date((now ?? Date.now()) - olderThanMs);
      const t = at(now);
      // A4-review-M-5: keep `kind='start'` for a row that was never a resume — a run killed before
      // its first checkpoint has no resume point, and re-queuing it as a resume turns a retry into
      // a 404 failure.
      const requeued = await sql.query(
        `UPDATE run_jobs SET status='queued', kind=CASE WHEN kind='start' THEN 'start' ELSE 'resume' END,
                locked_by=NULL, locked_at=NULL, updated_at=$3
          WHERE status='running' AND locked_at IS NOT NULL AND locked_at < $1 AND attempts < $2
          RETURNING run_id`,
        [cutoff, maxAttempts, t],
      );
      const failed = await sql.query(
        `UPDATE run_jobs SET status='failed', locked_by=NULL, locked_at=NULL, updated_at=$2,
                error='worker lease expired — the run was not completed'
          WHERE status='running' AND locked_at IS NOT NULL AND locked_at < $1
          RETURNING run_id`,
        [cutoff, t],
      );
      return {
        requeued: requeued.rows.map((r) => String(r.run_id)),
        failed: failed.rows.map((r) => String(r.run_id)),
      };
    },

    async get(runId) {
      const res = await sql.query(`SELECT ${JOB_COLS} FROM run_jobs WHERE run_id=$1`, [runId]);
      return res.rows.length > 0 ? toJob(res.rows[0]) : null;
    },

    async appendEvent(runId, event, data, when) {
      if (!isRunEventName(event)) throw new Error(`not a run event: ${String(event)}`);
      const t = at(when);
      // Only the lease holder writes a run's events, so the next seq is uncontended; a raced
      // insert (a stale worker that lost its lease) retries rather than throwing at the caller.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const res = await sql.query(
            `INSERT INTO run_events (run_id, seq, event, data, at)
             SELECT $1, COALESCE(MAX(seq),0)+1, $2, $3::jsonb, $4 FROM run_events WHERE run_id=$1
             RETURNING run_id, seq, event, data, at`,
            [runId, event, JSON.stringify(data ?? null), t],
          );
          return toEvent(res.rows[0]);
        } catch (e) {
          if (!isUniqueViolation(e) || attempt === 2) throw e;
        }
      }
      throw new Error(`run_events: could not append '${event}' for run '${runId}'`);
    },

    async eventsAfter(runId, afterSeq, limit = 500) {
      const res = await sql.query(
        `SELECT run_id, seq, event, data, at FROM run_events
          WHERE run_id=$1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [runId, afterSeq, limit],
      );
      return res.rows.map(toEvent);
    },

    async lastSeq(runId) {
      const res = await sql.query(`SELECT COALESCE(MAX(seq),0) AS seq FROM run_events WHERE run_id=$1`, [runId]);
      return Number(res.rows[0]?.seq ?? 0);
    },
  };
}

// ------------------------------------------------------------------ pool --

type PoolCache = { url: string; pool: SqlClient; ready: Promise<RunJobStore> };
const slot = globalThis as unknown as { __osRunJobsPool?: PoolCache };

/**
 * The process-wide store for `databaseUrl`: one `pg.Pool`, the idempotent DDL run once, cached per
 * URL. Pinned on `globalThis` (Next bundles route handlers separately and dev HMR re-evaluates
 * modules — a pool per module instance would leak connections). A failed migration drops the cache
 * so the next caller retries instead of being poisoned forever.
 */
export function runJobStoreFor(databaseUrl: string): Promise<RunJobStore> {
  const url = databaseUrl.trim();
  if (!url) throw new Error('runJobStoreFor: no AGENT_RUNS_DATABASE_URL');
  if (!slot.__osRunJobsPool || slot.__osRunJobsPool.url !== url) {
    let pool: SqlClient | undefined;
    const ready = (async (): Promise<RunJobStore> => {
      const { Pool } = await import('pg');
      // Small pool: the worker holds one claim at a time; os-ui only enqueues and tails.
      pool = new Pool({ connectionString: url, max: 6 }) as unknown as SqlClient;
      await migrateRunJobs(pool);
      return postgresRunJobStore(pool);
    })();
    slot.__osRunJobsPool = { url, pool: pool ?? ({ query: async () => ({ rows: [], rowCount: 0 }) } as SqlClient), ready };
    ready.catch(() => {
      if (slot.__osRunJobsPool?.ready === ready) delete slot.__osRunJobsPool;
    });
  }
  return slot.__osRunJobsPool.ready;
}
