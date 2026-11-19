/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        monitoring
 * FEATURE:    Agent runs in the runs lens and `list_runs` — read from the durable run store
 * USER STORY: As a builder I open Monitoring (or call `list_runs`) and see the agent runs that
 *             actually happened — including the ones the worker pod executed a minute ago and
 *             Langfuse has not ingested — newest first, each with how it really ended (a failed
 *             run reads red), filterable by system and by status.
 * ARCHITECTURE:
 *   - The source of agent runs is the run store (`run_jobs` + the outcome of each run's `done`
 *     frame) — the same rows the worker writes and `get_agent_run` reads. It is reached through
 *     the structural {@link RunListSource} port, so this module stays pure and is tested against
 *     a fake; `run-trace.ts` wires the process's real store.
 *   - SCOPE IN THE READ: the viewer's scope becomes the query's `visibleTo` (creator: own runs ·
 *     builder/domain_admin: own + their domains' · admin: all), so a creator's runs are never
 *     crowded out by the tenant's newest. `filterScope` is still applied by the callers, exactly
 *     as for every other lens. A listing row is the run's EXISTENCE and health; its contents stay
 *     owner-only behind `get_agent_run` / `get_run_trace`.
 *   - STATUS is one truthful word per run: `queued` / `running` from the job row; once it has
 *     stopped, the run's own report decides (`failed` wins over a row an older version settled
 *     `done`; `parked`, `interrupted`, `incomplete`, `done`). Health: failed red; parked,
 *     interrupted and incomplete amber; the rest green.
 *   - DEGRADED, NEVER SILENT: an unreachable store answers `{ ok: false, reason }` — the callers
 *     say so instead of returning an empty or invented list.
 */
import type { Health, HealthItem, Scope } from '@tabs/monitoring/lib/types';

/** The status vocabulary of a listed agent run. */
export const RUN_LIST_STATUSES = ['queued', 'running', 'done', 'failed', 'parked', 'interrupted', 'incomplete'] as const;
export type RunListStatus = (typeof RUN_LIST_STATUSES)[number];

export function isRunListStatus(v: unknown): v is RunListStatus {
  return typeof v === 'string' && (RUN_LIST_STATUSES as readonly string[]).includes(v);
}

type JobStatus = 'queued' | 'running' | 'parked' | 'done' | 'failed';

/** The fields of a run-store listing row this lens reads (structurally the agents store's `RunListRow`). */
export type RunListRowLike = {
  runId: string;
  systemId: string;
  domain: string;
  requestedBy: string;
  kind: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  report: {
    status?: string;
    failed?: boolean;
    interrupted?: boolean;
    parked?: boolean;
    reachedEnd?: boolean;
    failure?: { node?: string | null; reason?: string };
  } | null;
};

/** The run-store PORT this lens needs (the agents store's `RunJobStore` satisfies it). */
export type RunListSource = {
  listRuns(query: {
    systemId?: string;
    statuses?: readonly JobStatus[];
    visibleTo?: { requestedBy: string; domains: readonly string[] };
    limit: number;
  }): Promise<RunListRowLike[]>;
};

/** A listed agent run: a runs-lens item plus its status (additive to `HealthItem`). */
export type RunListItem = HealthItem & { status: RunListStatus; startedBy: string };

export type RunListFilter = { systemId?: string; status?: RunListStatus };

export type StoreRunsResult = { ok: true; items: RunListItem[] } | { ok: false; reason: string };

/** How a listed run stands — one word, the run's own report deciding once it has stopped. */
export function runListStatusOf(row: Pick<RunListRowLike, 'status' | 'report'>): RunListStatus {
  const r = row.report;
  if (row.status === 'queued' || row.status === 'running') return row.status;
  if (row.status === 'failed' || r?.failed === true) return 'failed';
  if (row.status === 'parked' || r?.parked === true) return 'parked';
  if (r?.interrupted === true || r?.status === 'interrupted') return 'interrupted';
  if (r?.status === 'incomplete' || (r && r.reachedEnd === false)) return 'incomplete';
  return 'done';
}

export function runListHealth(status: RunListStatus): Health {
  if (status === 'failed') return 'red';
  if (status === 'parked' || status === 'interrupted' || status === 'incomplete') return 'amber';
  return 'green';
}

/** The job statuses that can yield a listed status — the store-side pre-filter of `status`. */
function jobStatusesFor(status: RunListStatus): JobStatus[] {
  switch (status) {
    case 'queued':
    case 'running':
      return [status];
    case 'failed':
      return ['failed', 'done'];
    case 'parked':
      return ['parked', 'done'];
    default:
      return ['done'];
  }
}

/** The viewer's scope as the store query's `visibleTo` (absent = admin, every run). */
export function visibleToOf(scope: Scope): { requestedBy: string; domains: string[] } | undefined {
  if (scope.level === 'admin') return undefined;
  return { requestedBy: scope.principal, domains: scope.level === 'builder' ? [...scope.domains] : [] };
}

/** The domain shown for a run filed without one — the same sentinel the trace adapter uses. */
const NO_DOMAIN = '(unknown)';

function detailOf(status: RunListStatus, row: RunListRowLike): string {
  const who = `started by ${row.requestedBy}`;
  switch (status) {
    case 'failed': {
      const node = row.report?.failure?.node;
      const reason = row.report?.failure?.reason ?? row.error ?? 'the run failed';
      return `failed${node ? ` at ${node}` : ''} — ${reason} · ${who}`;
    }
    case 'parked':
      return `parked — waiting on an approval decision · ${who}`;
    case 'interrupted':
      return `interrupted before the end — resumable · ${who}`;
    case 'incomplete':
      return `stopped at the step budget before the end · ${who}`;
    default:
      return `${status} · ${who}`;
  }
}

/** One run-store row as a runs-lens item. `name` is the system's display name when known. */
export function runItemOf(row: RunListRowLike, name?: string): RunListItem {
  const status = runListStatusOf(row);
  return {
    id: row.runId,
    lens: 'runs',
    title: `${name || row.systemId} — agent run`,
    health: runListHealth(status),
    status,
    startedBy: row.requestedBy,
    detail: detailOf(status, row),
    owner: row.requestedBy,
    domain: row.domain.trim() || NO_DOMAIN,
    ts: new Date(row.createdAt).toISOString(),
    links: { runId: row.runId, systemId: row.systemId },
    source: 'live',
  };
}

/**
 * The viewer's agent runs from the run store, scoped in the read, filtered, newest first.
 * A failure to reach the store is reported, never turned into an empty list.
 */
export async function storeRuns(
  load: () => Promise<RunListSource>,
  opts: { scope?: Scope; filter?: RunListFilter; limit: number; nameOf?: (systemId: string) => string | undefined },
): Promise<StoreRunsResult> {
  const { filter = {}, limit } = opts;
  let rows: RunListRowLike[];
  try {
    const source = await load();
    rows = await source.listRuns({
      ...(filter.systemId ? { systemId: filter.systemId } : {}),
      ...(filter.status ? { statuses: jobStatusesFor(filter.status) } : {}),
      ...(opts.scope ? { visibleTo: visibleToOf(opts.scope) } : {}),
      // A status the store cannot pre-filter exactly (e.g. `failed` also lives in `done` rows) is
      // over-read, then narrowed below.
      limit: filter.status ? Math.min(limit * 4, 400) : limit,
    });
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message || String(e) };
  }
  const items = rows
    .map((r) => runItemOf(r, opts.nameOf?.(r.systemId)))
    .filter((it) => !filter.status || it.status === filter.status)
    .sort((a, b) => Date.parse(b.ts ?? '') - Date.parse(a.ts ?? ''))
    .slice(0, limit);
  return { ok: true, items };
}
