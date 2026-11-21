/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Dagster reads for the Monitoring Data panel — check-execution history, Dagster's own
 *             downstream lineage, and run health per job and schedule.
 * USER STORY: As a data engineer I want each dataset's job and schedule health, its quality trend and
 *             the assets impacted downstream, all as Dagster records them.
 * ARCHITECTURE:
 *   - GraphQL through the one typed client (`gql` in core/infra/dagster.ts), READ-ONLY:
 *     `assetCheckExecutions(assetKey, checkName, limit)` and `assetNodes { dependedByKeys }`
 *     (https://docs.dagster.io/api/graphql).
 *   - `jobHealthOf` groups `runsOrError` rows (already read by `recentOsRuns`) by the run's own
 *     `os/dataset` tag, job name and `dagster/schedule_name` tag, for the asked datasets only.
 *   - `downstreamOf` is the transitive closure of `dependedByKeys` — Dagster's lineage, not the OS's.
 */
import { gql, type DagsterDeps, type DagsterRun, type Fetched } from '@core/infra/dagster';

export type CheckExecution = { runId: string; at: string; passed: boolean | null; status: string };

const EXECUTIONS = `query Ex($key: AssetKeyInput!, $name: String!, $limit: Int!) { assetCheckExecutions(assetKey: $key, checkName: $name, limit: $limit) { runId status timestamp evaluation { success } } }`;

/** A check's executions, newest first. `passed` null while it has no evaluation (in progress / skipped). */
export async function checkExecutions(key: string[], checkName: string, limit = 10, deps: DagsterDeps = {}): Promise<Fetched<CheckExecution[]>> {
  const r = await gql<{ assetCheckExecutions: Record<string, unknown>[] }>(EXECUTIONS, { key: { path: key }, name: checkName, limit }, deps);
  if (!r.ok) return r;
  return {
    ok: true,
    data: (r.data.assetCheckExecutions ?? []).map((e) => {
      const ev = e.evaluation as { success?: boolean } | null;
      return { runId: String(e.runId ?? ''), at: new Date(Number(e.timestamp) * 1000).toISOString(), passed: typeof ev?.success === 'boolean' ? ev.success : null, status: String(e.status ?? '') };
    }),
  };
}

export type DependedBy = Map<string, string[][]>;
const k = (key: string[]) => key.join('/');

const GRAPH = `query DependedBy { assetNodes { assetKey { path } dependedByKeys { path } } }`;

/** Every asset → the assets that read it (Dagster's own lineage). */
export async function dependedByGraph(deps: DagsterDeps = {}): Promise<Fetched<DependedBy>> {
  const r = await gql<{ assetNodes: Record<string, unknown>[] }>(GRAPH, {}, deps);
  if (!r.ok) return r;
  const out: DependedBy = new Map();
  for (const n of r.data.assetNodes ?? []) {
    const path = (n.assetKey as { path?: string[] })?.path ?? [];
    out.set(k(path), ((n.dependedByKeys as { path?: string[] }[]) ?? []).map((d) => d.path ?? []));
  }
  return { ok: true, data: out };
}

/** The assets transitively downstream of `from` (excluding `from` itself), sorted by key. */
export function downstreamOf(g: DependedBy, from: string[][]): string[][] {
  const start = new Set(from.map(k));
  const seen = new Map<string, string[]>();
  const queue = [...from];
  while (queue.length) {
    for (const next of g.get(k(queue.shift()!)) ?? []) {
      const id = k(next);
      if (start.has(id) || seen.has(id)) continue;
      seen.set(id, next);
      queue.push(next);
    }
  }
  return [...seen.values()].sort((a, b) => k(a).localeCompare(k(b)));
}

export type RunGroupHealth = { name: string; runs: number; failures: number; lastStatus: string; lastRunAt: string | null; lastSuccessAt: string | null; lastFailureRunId: string | null; runIds: string[] };
export type DatasetRunHealth = { datasetId: string; jobs: RunGroupHealth[]; schedules: RunGroupHealth[] };

function fold(groups: Map<string, RunGroupHealth>, name: string, r: DagsterRun): void {
  let g = groups.get(name);
  // Runs arrive newest first: the first one seen is the latest.
  if (!g) groups.set(name, (g = { name, runs: 0, failures: 0, lastStatus: r.status, lastRunAt: r.startedAt, lastSuccessAt: null, lastFailureRunId: null, runIds: [] }));
  g.runs += 1;
  g.runIds.push(r.runId);
  if (r.status === 'FAILURE') {
    g.failures += 1;
    g.lastFailureRunId ??= r.runId;
  }
  if (r.status === 'SUCCESS' && !g.lastSuccessAt) g.lastSuccessAt = r.endedAt ?? r.startedAt;
}

/** Run health per job and per schedule for each asked dataset (its `os/dataset` tag), from newest-first runs. */
export function jobHealthOf(runs: readonly DagsterRun[], datasetIds: readonly string[]): Map<string, DatasetRunHealth> {
  const asked = new Set(datasetIds);
  const jobs = new Map<string, Map<string, RunGroupHealth>>();
  const schedules = new Map<string, Map<string, RunGroupHealth>>();
  for (const r of runs) {
    const ds = r.tags['os/dataset'];
    if (!ds || !asked.has(ds)) continue;
    if (!jobs.has(ds)) jobs.set(ds, new Map());
    fold(jobs.get(ds)!, r.jobName || 'unknown', r);
    const sched = r.tags['dagster/schedule_name'];
    if (sched) {
      if (!schedules.has(ds)) schedules.set(ds, new Map());
      fold(schedules.get(ds)!, sched, r);
    }
  }
  const out = new Map<string, DatasetRunHealth>();
  for (const [ds, j] of jobs) out.set(ds, { datasetId: ds, jobs: [...j.values()], schedules: [...(schedules.get(ds)?.values() ?? [])] });
  return out;
}
