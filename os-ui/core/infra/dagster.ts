/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    dagster — the ONE typed GraphQL client for the `sovereign` code location
 * USER STORY: As a data engineer I want the OS to launch my dataset's dbt assets in Dagster as me
 *             and to read run state, test results (asset checks), freshness (materializations), the
 *             asset graph and the next tick straight from Dagster — the OS keeps no parallel ledger
 *             (checklist D9), and a Dagster outage is reported as such, never as fake data.
 * ARCHITECTURE:
 *   - `Fetched<T>` result style (as `litellm-admin.ts`): nothing here throws, retries or logs a
 *     payload; a non-2xx, a GraphQL error, an unexpected union member, a timeout and a transport
 *     error are all `{ok:false, error}`. Callers decide what a failure means.
 *   - One `gql()` with a hard timeout and `cache: 'no-store'`; `fetch` is injectable for tests.
 *   - Launch tags: `os/dataset`, `os/principal`, `os/domain`, `os/commit`, `os/user`, `os/action`,
 *     plus `dagster-k8s/config` carrying the run pod's env (`OS_PRINCIPAL` = the Trino user
 *     dbt-trino impersonates; `OS_PINNED_COMMITS` = the commits the run pod checks out). The env
 *     values are principals and shas — never secrets; this module logs nothing anyway.
 *   - The selection is a list of asset keys (`[<domain>, <dbt node>]`); the job is the per-domain
 *     `<domain>__all` job the location defines, or a schedule's job when the caller names one.
 *   - `server-only`: the Dagster URL is cluster-internal.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { config } from '@core/kernel/config';

/** A read either produced data or produced a reason. It never throws. */
export type Fetched<T> = { ok: true; data: T } | { ok: false; error: string };

/** Dagster lives next to us in-cluster; a slow read must not stall a page. Launches may take longer. */
export const DEFAULT_TIMEOUT_MS = 4000;
export const LAUNCH_TIMEOUT_MS = 15000;

export type DagsterDeps = {
  fetch?: typeof fetch;
  url?: string;
  location?: string;
  repository?: string;
  timeoutMs?: number;
};

export type RunStatus =
  | 'QUEUED' | 'NOT_STARTED' | 'MANAGED' | 'STARTING' | 'STARTED' | 'SUCCESS' | 'FAILURE' | 'CANCELING' | 'CANCELED';

export type DagsterRun = {
  runId: string;
  status: RunStatus;
  jobName: string;
  /** ISO timestamps (Dagster reports unix seconds). */
  startedAt: string | null;
  endedAt: string | null;
  tags: Record<string, string>;
  /** Asset keys the run was launched for (paths joined with `/`), when the run carried a selection. */
  assetSelection: string[];
};

export type AssetCheckStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'EXECUTION_FAILED' | 'SKIPPED';

export type AssetCheck = {
  name: string;
  description: string | null;
  /** Null when the check never executed. */
  latest: {
    status: AssetCheckStatus;
    runId: string | null;
    /** ISO. */
    at: string | null;
    severity: 'WARN' | 'ERROR' | null;
    description: string | null;
    /** `metadata` dagster-dbt attaches (e.g. `dagster_dbt/failed_row_count`). */
    metadata: Record<string, string | number | null>;
  } | null;
};

export type Materialization = { runId: string; at: string };

export type AssetNode = { key: string[]; dependsOn: string[][]; group: string | null; description: string | null };

export type ScheduleTick = {
  name: string;
  cron: string;
  timezone: string | null;
  status: 'RUNNING' | 'STOPPED';
  /** ISO of the next tick, or null when stopped / unknown. */
  nextTickAt: string | null;
};

export type LaunchInput = {
  /** Defaults to `<domain>__all` when `domain` is given. */
  jobName?: string;
  domain?: string;
  /** Asset keys as paths, e.g. `[['sales','gold_orders']]`. Empty = the whole job. */
  selection?: string[][];
  tags?: Record<string, string>;
  /** Env the run pod receives (dagster-k8s/config). */
  env?: Record<string, string>;
};

export type Launched = { runId: string; status: RunStatus };

function iso(seconds: unknown): string | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function tagMap(tags: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(tags)) for (const t of tags as { key?: string; value?: string }[]) if (t?.key) out[t.key] = String(t.value ?? '');
  return out;
}

export function dagsterConfigured(deps: DagsterDeps = {}): boolean {
  return (deps.url ?? config.dagsterUrl).length > 0;
}

/** The `dagster-k8s/config` tag body: env the K8s run launcher injects into the run pod. */
export function k8sEnvTag(env: Record<string, string>): string {
  const names = Object.keys(env).sort();
  return JSON.stringify({ container_config: { env: names.map((name) => ({ name, value: String(env[name]) })) } });
}

/**
 * POST one GraphQL document. `{ok:false}` for a non-2xx, GraphQL `errors`, a timeout or a transport
 * error. The data is returned untyped; each operation below narrows it.
 */
export async function gql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>, deps: DagsterDeps = {}, timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<Fetched<T>> {
  const url = deps.url ?? config.dagsterUrl;
  if (!url) return { ok: false, error: 'Dagster is not configured' };
  const f = deps.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(`${url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
    if (Array.isArray(body.errors) && body.errors.length) return { ok: false, error: body.errors.map((e) => e.message ?? 'error').join('; ').slice(0, 500) };
    if (!body.data) return { ok: false, error: 'empty GraphQL response' };
    return { ok: true, data: body.data };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err?.message || 'fetch failed') };
  } finally {
    clearTimeout(timer);
  }
}

function selector(deps: DagsterDeps): { repositoryLocationName: string; repositoryName: string } {
  return { repositoryLocationName: deps.location ?? config.dagsterLocation, repositoryName: deps.repository ?? config.dagsterRepository };
}

const RUN_FIELDS = `id runId status jobName startTime endTime tags { key value } assetSelection { path }`;

function toRun(r: Record<string, unknown>): DagsterRun {
  return {
    runId: String(r.runId ?? r.id ?? ''),
    status: String(r.status ?? 'NOT_STARTED') as RunStatus,
    jobName: String(r.jobName ?? ''),
    startedAt: iso(r.startTime),
    endedAt: iso(r.endTime),
    tags: tagMap(r.tags),
    assetSelection: Array.isArray(r.assetSelection) ? (r.assetSelection as { path?: string[] }[]).map((a) => (a?.path ?? []).join('/')) : [],
  };
}

/* ------------------------------------------------------------------ launch -- */

const LAUNCH = `mutation LaunchRun($params: ExecutionParams!) {
  launchRun(executionParams: $params) {
    __typename
    ... on LaunchRunSuccess { run { ${RUN_FIELDS} } }
    ... on PythonError { message }
    ... on InvalidSubsetError { message }
    ... on RunConfigValidationInvalid { errors { message } }
    ... on PipelineNotFoundError { message }
    ... on UnauthorizedError { message }
    ... on ConflictingExecutionParamsError { message }
    ... on PresetNotFoundError { message }
    ... on NoModeProvidedError { message }
    ... on InvalidStepError { invalidStepKey }
    ... on InvalidOutputError { invalidOutputName }
  }
}`;

/** Launch a run of a job with an optional asset subset, tags and run-pod env. */
export async function launchRun(input: LaunchInput, deps: DagsterDeps = {}): Promise<Fetched<Launched>> {
  const jobName = input.jobName ?? (input.domain ? `${sanitizeName(input.domain)}__all` : '');
  if (!jobName) return { ok: false, error: 'launchRun needs a jobName or a domain' };
  const tags: Record<string, string> = { ...(input.tags ?? {}) };
  if (input.env && Object.keys(input.env).length) tags['dagster-k8s/config'] = k8sEnvTag(input.env);
  const params = {
    selector: {
      ...selector(deps),
      jobName,
      ...(input.selection && input.selection.length ? { assetSelection: input.selection.map((path) => ({ path })) } : {}),
    },
    runConfigData: {},
    executionMetadata: { tags: Object.entries(tags).map(([key, value]) => ({ key, value })) },
  };
  const r = await gql<{ launchRun: Record<string, unknown> }>(LAUNCH, { params }, deps, deps.timeoutMs ?? LAUNCH_TIMEOUT_MS);
  if (!r.ok) return r;
  const out = r.data.launchRun ?? {};
  if (out.__typename === 'LaunchRunSuccess') {
    const run = toRun((out.run ?? {}) as Record<string, unknown>);
    return { ok: true, data: { runId: run.runId, status: run.status } };
  }
  return { ok: false, error: describeUnion(out) };
}

/** Dagster names are `^[A-Za-z0-9_]+$` — the same rule as `os_projects.sanitize`. */
export function sanitizeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, '_');
  return s && !/^\d/.test(s) ? s : `_${s}`;
}

/**
 * `{original: unique Dagster-safe name}` — the TypeScript twin of `os_projects.sanitize_all`.
 *
 * `sanitizeName` is lossy (`sales-eu` and `sales.eu` both give `sales_eu`), and the code location
 * resolves such a collision by appending a 6-hex digest of the ORIGINAL name to every later
 * claimant in sorted order (review B2-review-M2). Before B3 the OS could not compute that, so for a
 * collided domain `scheduleNameFor` named a schedule that did not exist and the panel showed no
 * next tick. Now the OS runs the SAME algorithm over the domain list it already has from
 * `GET /api/data/projects`, and a shared golden
 * (`images/extensions/dagster/tests/sanitize-collisions.golden.json`) is asserted by BOTH languages
 * so the two can never drift.
 */
export function sanitizeAll(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const name of [...new Set(names.map((n) => String(n)))].sort()) {
    const base = sanitizeName(name);
    let candidate = base;
    if (taken.has(candidate)) {
      const digest = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 6);
      candidate = `${base}_${digest}`;
      let n = 2;
      while (taken.has(candidate)) candidate = `${base}_${digest}_${n++}`;
    }
    taken.add(candidate);
    out[name] = candidate;
  }
  return out;
}

function describeUnion(out: Record<string, unknown>): string {
  const t = String(out.__typename ?? 'UnknownError');
  if (typeof out.message === 'string') return `${t}: ${out.message.slice(0, 400)}`;
  if (Array.isArray(out.errors)) return `${t}: ${(out.errors as { message?: string }[]).map((e) => e.message).join('; ').slice(0, 400)}`;
  return t;
}

/* -------------------------------------------------------------------- runs -- */

const RUN = `query Run($id: ID!) { runOrError(runId: $id) { __typename ... on Run { ${RUN_FIELDS} } ... on RunNotFoundError { message } ... on PythonError { message } } }`;

export async function run(runId: string, deps: DagsterDeps = {}): Promise<Fetched<DagsterRun>> {
  const r = await gql<{ runOrError: Record<string, unknown> }>(RUN, { id: runId }, deps);
  if (!r.ok) return r;
  const out = r.data.runOrError ?? {};
  if (out.__typename === 'Run') return { ok: true, data: toRun(out) };
  return { ok: false, error: describeUnion(out) };
}

const RUNS = `query Runs($filter: RunsFilter, $limit: Int) { runsOrError(filter: $filter, limit: $limit) { __typename ... on Runs { results { ${RUN_FIELDS} } } ... on InvalidPipelineRunsFilterError { message } ... on PythonError { message } } }`;

/** Runs carrying every given tag, newest first. */
export async function runsByTags(tags: Record<string, string>, limit = 25, deps: DagsterDeps = {}): Promise<Fetched<DagsterRun[]>> {
  const filter = { tags: Object.entries(tags).map(([key, value]) => ({ key, value })) };
  const r = await gql<{ runsOrError: Record<string, unknown> }>(RUNS, { filter, limit }, deps);
  if (!r.ok) return r;
  const out = r.data.runsOrError ?? {};
  if (out.__typename === 'Runs') return { ok: true, data: ((out.results as Record<string, unknown>[]) ?? []).map(toRun) };
  return { ok: false, error: describeUnion(out) };
}

/** The dataset's runs (scheduled syncs and OS launches both carry `os/dataset`). Newest first. */
export function runsForDataset(datasetId: string, limit = 20, deps: DagsterDeps = {}): Promise<Fetched<DagsterRun[]>> {
  return runsByTags({ 'os/dataset': datasetId }, limit, deps);
}

/** The most recent runs of every OS-tagged job (Monitoring). */
export async function recentOsRuns(limit = 50, deps: DagsterDeps = {}): Promise<Fetched<DagsterRun[]>> {
  const r = await gql<{ runsOrError: Record<string, unknown> }>(RUNS, { filter: {}, limit }, deps);
  if (!r.ok) return r;
  const out = r.data.runsOrError ?? {};
  if (out.__typename === 'Runs') return { ok: true, data: ((out.results as Record<string, unknown>[]) ?? []).map(toRun) };
  return { ok: false, error: describeUnion(out) };
}

/* ------------------------------------------------------------------ checks -- */

const CHECK_FIELDS = `name description executionForLatestMaterialization { runId status timestamp evaluation { severity description metadataEntries { label ... on TextMetadataEntry { text } ... on IntMetadataEntry { intValue } ... on FloatMetadataEntry { floatValue } } } }`;

function toCheck(c: Record<string, unknown>): AssetCheck {
  const ex = (c.executionForLatestMaterialization ?? null) as Record<string, unknown> | null;
  const ev = (ex?.evaluation ?? null) as Record<string, unknown> | null;
  const metadata: Record<string, string | number | null> = {};
  for (const m of (Array.isArray(ev?.metadataEntries) ? ev!.metadataEntries : []) as Record<string, unknown>[]) {
    if (!m?.label) continue;
    metadata[String(m.label)] = typeof m.intValue === 'number' ? m.intValue : typeof m.floatValue === 'number' ? m.floatValue : typeof m.text === 'string' ? m.text : null;
  }
  return {
    name: String(c.name ?? ''),
    description: typeof c.description === 'string' ? c.description : null,
    latest: ex
      ? {
          status: String(ex.status ?? 'SKIPPED') as AssetCheckStatus,
          runId: ex.runId ? String(ex.runId) : null,
          at: iso(ex.timestamp),
          severity: ev?.severity === 'WARN' || ev?.severity === 'ERROR' ? ev.severity : null,
          description: typeof ev?.description === 'string' ? ev.description : null,
          metadata,
        }
      : null,
  };
}

const CHECKS = `query Checks($key: AssetKeyInput!) { assetChecksOrError(assetKey: $key) { __typename ... on AssetChecks { checks { ${CHECK_FIELDS} } } ... on AssetCheckNeedsMigrationError { message } ... on AssetCheckNeedsUserCodeUpgrade { message } ... on AssetCheckNeedsAgentUpgradeError { message } } }`;

/** The asset's checks (dagster-dbt maps each dbt test to one) with their latest execution. */
export async function assetChecks(assetKey: string[], deps: DagsterDeps = {}): Promise<Fetched<AssetCheck[]>> {
  const r = await gql<{ assetChecksOrError: Record<string, unknown> }>(CHECKS, { key: { path: assetKey } }, deps);
  if (!r.ok) return r;
  const out = r.data.assetChecksOrError ?? {};
  if (out.__typename === 'AssetChecks') return { ok: true, data: ((out.checks as Record<string, unknown>[]) ?? []).map(toCheck) };
  return { ok: false, error: describeUnion(out) };
}

const ALL_CHECKS = `query AllChecks { assetNodes { assetKey { path } assetChecksOrError { __typename ... on AssetChecks { checks { ${CHECK_FIELDS} } } } } }`;

/** Every asset's checks in one round trip (Monitoring lists). Keyed by the asset path joined with `/`. */
export async function allAssetChecks(deps: DagsterDeps = {}): Promise<Fetched<Record<string, AssetCheck[]>>> {
  const r = await gql<{ assetNodes: Record<string, unknown>[] }>(ALL_CHECKS, {}, deps);
  if (!r.ok) return r;
  const out: Record<string, AssetCheck[]> = {};
  for (const n of r.data.assetNodes ?? []) {
    const path = ((n.assetKey as { path?: string[] })?.path ?? []).join('/');
    const c = (n.assetChecksOrError ?? {}) as Record<string, unknown>;
    if (c.__typename === 'AssetChecks') out[path] = ((c.checks as Record<string, unknown>[]) ?? []).map(toCheck);
  }
  return { ok: true, data: out };
}

/* --------------------------------------------------------- materializations -- */

const LATEST = `query Latest($key: AssetKeyInput!) { assetOrError(assetKey: $key) { __typename ... on Asset { assetMaterializations(limit: 1) { runId timestamp } } ... on AssetNotFoundError { message } } }`;

/** The latest materialization of an asset, or `null` data when it never materialized. */
export async function latestMaterialization(assetKey: string[], deps: DagsterDeps = {}): Promise<Fetched<Materialization | null>> {
  const r = await gql<{ assetOrError: Record<string, unknown> }>(LATEST, { key: { path: assetKey } }, deps);
  if (!r.ok) return r;
  const out = r.data.assetOrError ?? {};
  if (out.__typename === 'AssetNotFoundError') return { ok: true, data: null };
  if (out.__typename !== 'Asset') return { ok: false, error: describeUnion(out) };
  const m = ((out.assetMaterializations as Record<string, unknown>[]) ?? [])[0];
  if (!m) return { ok: true, data: null };
  const ms = Number(m.timestamp); // materializations report milliseconds as a string
  return { ok: true, data: { runId: String(m.runId ?? ''), at: Number.isFinite(ms) ? new Date(ms).toISOString() : '' } };
}

/* ------------------------------------------------------------------- graph -- */

const GRAPH = `query Graph { assetNodes { assetKey { path } dependencyKeys { path } groupName description } }`;

export async function assetGraph(deps: DagsterDeps = {}): Promise<Fetched<AssetNode[]>> {
  const r = await gql<{ assetNodes: Record<string, unknown>[] }>(GRAPH, {}, deps);
  if (!r.ok) return r;
  return {
    ok: true,
    data: (r.data.assetNodes ?? []).map((n) => ({
      key: (n.assetKey as { path?: string[] })?.path ?? [],
      dependsOn: Array.isArray(n.dependencyKeys) ? (n.dependencyKeys as { path?: string[] }[]).map((d) => d.path ?? []) : [],
      group: typeof n.groupName === 'string' ? n.groupName : null,
      description: typeof n.description === 'string' ? n.description : null,
    })),
  };
}

/* ---------------------------------------------------------------- location -- */

const RELOAD = `mutation Reload($n: String!) { reloadRepositoryLocation(repositoryLocationName: $n) { __typename ... on WorkspaceLocationEntry { name } ... on PythonError { message } ... on RepositoryLocationNotFound { message } ... on ReloadNotSupported { message } ... on UnauthorizedError { message } } }`;

export async function reloadLocation(name?: string, deps: DagsterDeps = {}): Promise<Fetched<{ name: string }>> {
  const n = name ?? deps.location ?? config.dagsterLocation;
  const r = await gql<{ reloadRepositoryLocation: Record<string, unknown> }>(RELOAD, { n }, deps, deps.timeoutMs ?? LAUNCH_TIMEOUT_MS);
  if (!r.ok) return r;
  const out = r.data.reloadRepositoryLocation ?? {};
  if (out.__typename === 'WorkspaceLocationEntry') return { ok: true, data: { name: String(out.name ?? n) } };
  return { ok: false, error: describeUnion(out) };
}

/* --------------------------------------------------------------- schedules -- */

const SCHEDULE = `query Schedule($sel: ScheduleSelector!) { scheduleOrError(scheduleSelector: $sel) { __typename ... on Schedule { name cronSchedule executionTimezone scheduleState { status } futureTicks(limit: 1) { results { timestamp } } } ... on ScheduleNotFoundError { message } ... on PythonError { message } } }`;

/** A schedule's state and its next tick (null when stopped or unknown). */
export async function nextTick(scheduleName: string, deps: DagsterDeps = {}): Promise<Fetched<ScheduleTick>> {
  const sel = { ...selector(deps), scheduleName };
  const r = await gql<{ scheduleOrError: Record<string, unknown> }>(SCHEDULE, { sel }, deps);
  if (!r.ok) return r;
  const out = r.data.scheduleOrError ?? {};
  if (out.__typename !== 'Schedule') return { ok: false, error: describeUnion(out) };
  const status = ((out.scheduleState as { status?: string })?.status ?? 'STOPPED') === 'RUNNING' ? 'RUNNING' : 'STOPPED';
  const tick = (((out.futureTicks as { results?: { timestamp?: number }[] })?.results ?? [])[0]) ?? null;
  return {
    ok: true,
    data: {
      name: String(out.name ?? scheduleName),
      cron: String(out.cronSchedule ?? ''),
      timezone: typeof out.executionTimezone === 'string' ? out.executionTimezone : null,
      status,
      nextTickAt: status === 'RUNNING' ? iso(tick?.timestamp) : null,
    },
  };
}

/* ------------------------------------------------------------------ naming -- */

/**
 * The schedule the location defines for a dataset's sync: `<domain>__<datasetId>`
 * (`os_projects.schedule_name`).
 *
 * `allDomains` is every domain the location loaded (the repo index). Pass it whenever it is known:
 * without it a domain whose sanitized name collides with another's gets the plain form, which is
 * NOT the name the location used, and the next-tick read returns not-found.
 */
export function scheduleNameFor(domain: string, datasetId: string, allDomains?: string[]): string {
  const name = allDomains && allDomains.length ? (sanitizeAll(allDomains)[domain] ?? sanitizeName(domain)) : sanitizeName(domain);
  return `${name}__${sanitizeName(datasetId)}`;
}

/** The asset key of a dbt model in the location: `[<domain>, <model>]`. */
export function modelAssetKey(domain: string, model: string): string[] {
  return [domain, model];
}
