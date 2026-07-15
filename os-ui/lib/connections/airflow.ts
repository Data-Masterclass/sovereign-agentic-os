/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection, AirflowAuthType } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { getConnectionForUser } from '@/lib/connections/store';

/**
 * Apache Airflow REST client — the per-connection bridge to a customer's Airflow.
 *
 * A governed OUTBOUND connection: OS agents trigger + monitor DAGs through the same
 * capability gate every other connection tool passes (list/get are Read; trigger is
 * a Write held for approval by default). This module is the PURE, testable client
 * (`fetch` injected, the credential injected as ARGS, never logged/returned) plus a
 * thin SERVER-SIDE bridge that resolves the connection under the caller's identity
 * (DLS) and dereferences the vaulted secret HERE (never leaves the server).
 *
 * Same discipline as `lib/data/openmetadata`: every call NEVER throws to the caller
 * — it degrades to `{ ok:false, reason }` so honest errors surface without crashing.
 *
 * PATH SHAPES: Airflow's stable REST API is v2 (`/api/v2/...`); older deployments
 * only expose v1 (`/api/v1/...`). Reads TRY v2 first and fall back to v1 on a 404,
 * so one connection works against either. The trigger POST body is identical on
 * both (`{ conf, logical_date? }`).
 */

/** Injectable fetch — the global `fetch` in prod, a fake in tests. */
export type AirflowFetch = typeof fetch;

/** A per-connection Airflow client config: where + how to authenticate. */
export type AirflowConn = {
  /** Airflow base URL (the connection endpoint), e.g. https://airflow.example.com. */
  baseUrl: string;
  /** How to authenticate: Basic (username + password) or a Bearer token. */
  authType: AirflowAuthType;
  /** Basic-auth username (non-secret). Empty/ignored for Bearer. */
  username?: string;
  /** The secret — the Basic password OR the Bearer token (resolved from the vault). */
  secret?: string;
  fetchImpl: AirflowFetch;
  timeoutMs?: number;
};

/** An Airflow read that never throws: either data, or an honest failure reason. */
export type AirflowRead<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string };

/** A lightly-typed DAG (only the fields monitoring/triggering needs). */
export type AirflowDag = { dagId: string; isPaused: boolean; description: string };
/** A lightly-typed DAG run. */
export type AirflowDagRun = {
  dagId: string;
  dagRunId: string;
  state: string;
  logicalDate: string;
};
/** A lightly-typed task instance (task-level status inside a run). */
export type AirflowTaskInstance = {
  taskId: string;
  state: string;
  tryNumber: number;
  startDate: string;
  endDate: string;
};
/** A lightly-typed data-driven asset/dataset (v2 "assets" / v1 "datasets"). */
export type AirflowDataset = { id: number; uri: string };
/** A lightly-typed asset/dataset event (a producing task updated the asset). */
export type AirflowDatasetEvent = {
  datasetId: number;
  datasetUri: string;
  sourceDagId: string;
  sourceRunId: string;
  timestamp: string;
};

/** Max characters of task-log text returned to a tool caller (logs can be huge). */
export const AIRFLOW_LOG_MAX = 8000;

async function withTimeout(
  fetchImpl: AirflowFetch,
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the auth headers. Basic → `Authorization: Basic base64(user:pass)`; Bearer →
 * `Authorization: Bearer <token>`. The secret is used ONLY to construct the header;
 * it is never returned or logged. Absent secret ⇒ no Authorization header (the call
 * will honestly fail auth rather than send a broken header).
 */
export function airflowAuthHeaders(conn: AirflowConn): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (!conn.secret) return h;
  if (conn.authType === 'basic') {
    const raw = `${conn.username ?? ''}:${conn.secret}`;
    h.authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  } else {
    h.authorization = `Bearer ${conn.secret}`;
  }
  return h;
}

function base(conn: AirflowConn): string {
  return conn.baseUrl.replace(/\/$/, '');
}

/**
 * GET one Airflow API path, trying v2 first then v1 on a 404. Never throws: a
 * non-OK status or a network error becomes an honest reason. `path` is the suffix
 * AFTER the version segment, e.g. `/dags?limit=100`.
 */
async function afGet(conn: AirflowConn, path: string): Promise<AirflowRead<unknown>> {
  const headers = airflowAuthHeaders(conn);
  for (const version of ['v2', 'v1'] as const) {
    try {
      const res = await withTimeout(
        conn.fetchImpl,
        `${base(conn)}/api/${version}${path}`,
        { method: 'GET', headers },
        conn.timeoutMs ?? 4000,
      );
      // v2 absent on an older instance → try v1; any other status is the real answer.
      if (res.status === 404 && version === 'v2') continue;
      if (!res.ok) return { ok: false, reason: `Airflow ${res.status}` };
      return { ok: true, data: await res.json() };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
  return { ok: false, reason: 'Airflow 404' };
}

/**
 * GET one Airflow API path as TEXT (task logs are text, not JSON), v2→v1 on 404.
 * Never throws. Used only for `get_task_logs`; the caller truncates for tool output.
 */
async function afGetText(conn: AirflowConn, path: string): Promise<AirflowRead<string>> {
  const headers = { ...airflowAuthHeaders(conn), accept: 'text/plain' };
  for (const version of ['v2', 'v1'] as const) {
    try {
      const res = await withTimeout(
        conn.fetchImpl,
        `${base(conn)}/api/${version}${path}`,
        { method: 'GET', headers },
        conn.timeoutMs ?? 4000,
      );
      if (res.status === 404 && version === 'v2') continue;
      if (!res.ok) return { ok: false, reason: `Airflow ${res.status}` };
      return { ok: true, data: await res.text() };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
  return { ok: false, reason: 'Airflow 404' };
}

/**
 * Send a WRITE (PATCH/POST) with a JSON body to one Airflow path, v2→v1 on 404.
 * Never throws. NOTE: the GOVERNANCE gate is enforced UPSTREAM in `callConnectionTool`
 * — a write helper is only reached once the call is allowed.
 */
async function afSend(
  conn: AirflowConn,
  method: 'PATCH' | 'POST',
  path: string,
  body: Record<string, unknown>,
): Promise<AirflowRead<unknown>> {
  const headers = { ...airflowAuthHeaders(conn), 'content-type': 'application/json' };
  for (const version of ['v2', 'v1'] as const) {
    try {
      const res = await withTimeout(
        conn.fetchImpl,
        `${base(conn)}/api/${version}${path}`,
        { method, headers, body: JSON.stringify(body) },
        conn.timeoutMs ?? 4000,
      );
      if (res.status === 404 && version === 'v2') continue;
      if (!res.ok) return { ok: false, reason: `Airflow ${res.status}` };
      return { ok: true, data: await res.json().catch(() => ({})) };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
  return { ok: false, reason: 'Airflow 404' };
}

/**
 * Liveness probe. Airflow exposes health at `/api/v2/monitor/health` (v2) or
 * `/api/v1/health` (v1); both are unauthenticated. ANY HTTP response means Airflow
 * is up; a network error / timeout means it is genuinely unreachable. When the body
 * carries a metadatabase/scheduler status we surface it, best-effort.
 */
export async function airflowHealth(
  conn: AirflowConn,
): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  const attempts = ['/api/v2/monitor/health', '/api/v1/health'];
  for (const p of attempts) {
    try {
      const res = await withTimeout(
        conn.fetchImpl,
        `${base(conn)}${p}`,
        { method: 'GET', headers: { accept: 'application/json' } },
        conn.timeoutMs ?? 4000,
      );
      if (res.status === 404 && p.startsWith('/api/v2')) continue;
      let detail: string | undefined;
      try {
        const j = (await res.json()) as { metadatabase?: { status?: string }; scheduler?: { status?: string } };
        const parts: string[] = [];
        if (j?.metadatabase?.status) parts.push(`metadatabase ${j.metadatabase.status}`);
        if (j?.scheduler?.status) parts.push(`scheduler ${j.scheduler.status}`);
        if (parts.length) detail = parts.join(', ');
      } catch {
        /* body is best-effort; connectivity already established */
      }
      return { connected: true, detail };
    } catch {
      return { connected: false, reason: 'unreachable' };
    }
  }
  return { connected: false, reason: 'unreachable' };
}

/** GET /dags — list DAGs. */
export async function listDags(conn: AirflowConn, limit = 100): Promise<AirflowRead<AirflowDag[]>> {
  const r = await afGet(conn, `/dags?limit=${limit}`);
  if (!r.ok) return r;
  const rows = (r.data as { dags?: Record<string, unknown>[] })?.dags;
  if (!Array.isArray(rows)) return { ok: false, reason: 'Airflow returned no DAG list' };
  return {
    ok: true,
    data: rows.map((d) => ({
      dagId: String(d.dag_id ?? ''),
      isPaused: Boolean(d.is_paused),
      description: String(d.description ?? ''),
    })),
  };
}

/** GET /dags/{dagId}/dagRuns/{runId} — read one DAG run. */
export async function getDagRun(
  conn: AirflowConn,
  dagId: string,
  runId: string,
): Promise<AirflowRead<AirflowDagRun>> {
  const r = await afGet(conn, `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}`);
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return {
    ok: true,
    data: {
      dagId: String(d.dag_id ?? dagId),
      dagRunId: String(d.dag_run_id ?? runId),
      state: String(d.state ?? ''),
      logicalDate: String(d.logical_date ?? ''),
    },
  };
}

/**
 * POST /dags/{dagId}/dagRuns — trigger a DAG run. Body is `{ conf, logical_date? }`
 * exactly as the Airflow REST API expects on both v1 and v2. `conf` defaults to an
 * empty object. NOTE: the GOVERNANCE gate (Write-approval) is enforced UPSTREAM in
 * `callConnectionTool` — this function is only reached once a call is allowed.
 */
export async function triggerDag(
  conn: AirflowConn,
  dagId: string,
  conf?: Record<string, unknown>,
  logicalDate?: string,
): Promise<AirflowRead<AirflowDagRun>> {
  const body: Record<string, unknown> = { conf: conf ?? {} };
  if (logicalDate) body.logical_date = logicalDate;
  const headers = { ...airflowAuthHeaders(conn), 'content-type': 'application/json' };
  for (const version of ['v2', 'v1'] as const) {
    try {
      const res = await withTimeout(
        conn.fetchImpl,
        `${base(conn)}/api/${version}/dags/${encodeURIComponent(dagId)}/dagRuns`,
        { method: 'POST', headers, body: JSON.stringify(body) },
        conn.timeoutMs ?? 4000,
      );
      if (res.status === 404 && version === 'v2') continue;
      if (!res.ok) return { ok: false, reason: `Airflow ${res.status}` };
      const d = (await res.json()) as Record<string, unknown>;
      return {
        ok: true,
        data: {
          dagId: String(d.dag_id ?? dagId),
          dagRunId: String(d.dag_run_id ?? ''),
          state: String(d.state ?? 'queued'),
          logicalDate: String(d.logical_date ?? logicalDate ?? ''),
        },
      };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
  return { ok: false, reason: 'Airflow 404' };
}

// --------------------------------------------------- observe (Read) -------------

function shapeRun(d: Record<string, unknown>, dagId: string): AirflowDagRun {
  return {
    dagId: String(d.dag_id ?? dagId),
    dagRunId: String(d.dag_run_id ?? ''),
    state: String(d.state ?? ''),
    logicalDate: String(d.logical_date ?? ''),
  };
}

/**
 * GET /dags/{dagId}/dagRuns — run history. Optional `state` filters (queued/running/
 * success/failed/…); `limit` bounds the page. Read: side-effect-free, auto-allowed.
 */
export async function listDagRuns(
  conn: AirflowConn,
  dagId: string,
  opts?: { limit?: number; state?: string },
): Promise<AirflowRead<AirflowDagRun[]>> {
  const q = new URLSearchParams({ limit: String(opts?.limit ?? 25) });
  if (opts?.state) q.set('state', opts.state);
  const r = await afGet(conn, `/dags/${encodeURIComponent(dagId)}/dagRuns?${q.toString()}`);
  if (!r.ok) return r;
  const rows = (r.data as { dag_runs?: Record<string, unknown>[] })?.dag_runs;
  if (!Array.isArray(rows)) return { ok: false, reason: 'Airflow returned no DAG-run list' };
  return { ok: true, data: rows.map((d) => shapeRun(d, dagId)) };
}

/**
 * GET /dags/{dagId}/dagRuns/{runId}/taskInstances — task-level status of one run.
 * Read: which tasks ran, which failed, retry counts. Auto-allowed.
 */
export async function getTaskInstances(
  conn: AirflowConn,
  dagId: string,
  runId: string,
): Promise<AirflowRead<AirflowTaskInstance[]>> {
  const r = await afGet(
    conn,
    `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}/taskInstances`,
  );
  if (!r.ok) return r;
  const rows = (r.data as { task_instances?: Record<string, unknown>[] })?.task_instances;
  if (!Array.isArray(rows)) return { ok: false, reason: 'Airflow returned no task-instance list' };
  return {
    ok: true,
    data: rows.map((d) => ({
      taskId: String(d.task_id ?? ''),
      state: String(d.state ?? ''),
      tryNumber: Number(d.try_number ?? 0),
      startDate: String(d.start_date ?? ''),
      endDate: String(d.end_date ?? ''),
    })),
  };
}

/**
 * GET /dags/{dagId}/dagRuns/{runId}/taskInstances/{taskId}/logs/{tryNumber} — the
 * task's log text (returned as text, not JSON). Truncated to `AIRFLOW_LOG_MAX` chars
 * for tool output (logs can be enormous). Read: auto-allowed. `truncated` flags a cut.
 */
export async function getTaskLogs(
  conn: AirflowConn,
  dagId: string,
  runId: string,
  taskId: string,
  opts?: { tryNumber?: number },
): Promise<AirflowRead<{ text: string; truncated: boolean }>> {
  const t = opts?.tryNumber ?? 1;
  const r = await afGetText(
    conn,
    `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}` +
      `/taskInstances/${encodeURIComponent(taskId)}/logs/${encodeURIComponent(String(t))}`,
  );
  if (!r.ok) return r;
  const full = r.data ?? '';
  const truncated = full.length > AIRFLOW_LOG_MAX;
  return { ok: true, data: { text: truncated ? full.slice(0, AIRFLOW_LOG_MAX) : full, truncated } };
}

/**
 * GET /dags/{dagId}/dagRuns/{runId}/taskInstances/{taskId}/xcomEntries/{key} — read
 * a task's XCom entry (default key `return_value`, its return value). Read.
 *
 * HONEST NOTE ON DATA SIZE: XCom is for SMALL control values (ids, counts, flags),
 * not datasets. Large outputs of a DAG land in a warehouse / object store, which the
 * OS reads via its WAREHOUSE connectors (the federated catalog) — NOT via XCom. Use
 * this to retrieve a small return value or a pointer (a table name / S3 URI), then
 * read the actual data through the warehouse connection.
 */
export async function getXcom(
  conn: AirflowConn,
  dagId: string,
  runId: string,
  taskId: string,
  opts?: { key?: string },
): Promise<AirflowRead<{ key: string; value: unknown }>> {
  const key = opts?.key ?? 'return_value';
  const r = await afGet(
    conn,
    `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}` +
      `/taskInstances/${encodeURIComponent(taskId)}/xcomEntries/${encodeURIComponent(key)}`,
  );
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return { ok: true, data: { key: String(d.key ?? key), value: d.value } };
}

/**
 * GET /assets (v2) or /datasets (v1) — Airflow data-driven scheduling objects. In
 * Airflow 3 "datasets" were renamed "assets"; we TRY assets first then fall back to
 * datasets, so one connection works on either. Read: auto-allowed.
 */
export async function listDatasets(
  conn: AirflowConn,
  limit = 50,
): Promise<AirflowRead<AirflowDataset[]>> {
  for (const noun of ['assets', 'datasets'] as const) {
    const r = await afGet(conn, `/${noun}?limit=${limit}`);
    if (!r.ok) {
      // "assets" absent (older instance) → try "datasets"; a hard error is the answer.
      if (noun === 'assets' && r.reason.includes('404')) continue;
      return r;
    }
    const rows =
      (r.data as { assets?: Record<string, unknown>[]; datasets?: Record<string, unknown>[] })?.assets ??
      (r.data as { datasets?: Record<string, unknown>[] })?.datasets;
    if (!Array.isArray(rows)) return { ok: false, reason: 'Airflow returned no asset/dataset list' };
    return { ok: true, data: rows.map((d) => ({ id: Number(d.id ?? 0), uri: String(d.uri ?? '') })) };
  }
  return { ok: false, reason: 'Airflow 404' };
}

/**
 * GET /assets/events (v2) or /datasets/events (v1) — asset/dataset update events
 * (which producing task updated which asset, when — the data-driven scheduling feed).
 * Try assets then datasets. Read: auto-allowed.
 */
export async function getDatasetEvents(
  conn: AirflowConn,
  limit = 50,
): Promise<AirflowRead<AirflowDatasetEvent[]>> {
  for (const noun of ['assets', 'datasets'] as const) {
    const r = await afGet(conn, `/${noun}/events?limit=${limit}`);
    if (!r.ok) {
      if (noun === 'assets' && r.reason.includes('404')) continue;
      return r;
    }
    const rows =
      (r.data as { asset_events?: Record<string, unknown>[]; dataset_events?: Record<string, unknown>[] })
        ?.asset_events ??
      (r.data as { dataset_events?: Record<string, unknown>[] })?.dataset_events;
    if (!Array.isArray(rows)) return { ok: false, reason: 'Airflow returned no asset/dataset events' };
    return {
      ok: true,
      data: rows.map((d) => ({
        datasetId: Number(d.dataset_id ?? d.asset_id ?? 0),
        datasetUri: String(d.dataset_uri ?? d.asset_uri ?? ''),
        sourceDagId: String(d.source_dag_id ?? ''),
        sourceRunId: String(d.source_run_id ?? ''),
        timestamp: String(d.timestamp ?? ''),
      })),
    };
  }
  return { ok: false, reason: 'Airflow 404' };
}

// --------------------------------------------- control (Write-approval) ---------

/**
 * PATCH /dags/{dagId} `{ is_paused }` — pause or unpause a DAG. A real side effect
 * (a paused DAG stops scheduling), so this is Write-approval upstream. Never throws.
 */
export async function setDagPaused(
  conn: AirflowConn,
  dagId: string,
  isPaused: boolean,
): Promise<AirflowRead<AirflowDag>> {
  const r = await afSend(conn, 'PATCH', `/dags/${encodeURIComponent(dagId)}`, { is_paused: isPaused });
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return {
    ok: true,
    data: {
      dagId: String(d.dag_id ?? dagId),
      isPaused: d.is_paused === undefined ? isPaused : Boolean(d.is_paused),
      description: String(d.description ?? ''),
    },
  };
}

/**
 * POST /dags/{dagId}/clearTaskInstances — clear (retry/rerun) task instances of a run.
 * `taskIds` scopes to specific tasks; `onlyFailed` limits to failed tasks. `dry_run`
 * is forced FALSE so the clear actually happens (this path is only reached post-gate).
 * A real side effect (re-runs tasks), so Write-approval upstream. Never throws.
 */
export async function clearTask(
  conn: AirflowConn,
  dagId: string,
  runId: string,
  opts?: { taskIds?: string[]; onlyFailed?: boolean },
): Promise<AirflowRead<{ cleared: number }>> {
  const body: Record<string, unknown> = { dry_run: false, dag_run_id: runId };
  if (opts?.taskIds && opts.taskIds.length) body.task_ids = opts.taskIds;
  if (opts?.onlyFailed) body.only_failed = true;
  const r = await afSend(conn, 'POST', `/dags/${encodeURIComponent(dagId)}/clearTaskInstances`, body);
  if (!r.ok) return r;
  const rows = (r.data as { task_instances?: unknown[] })?.task_instances;
  return { ok: true, data: { cleared: Array.isArray(rows) ? rows.length : 0 } };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure client config from a resolved `airflow` connection. The secret is
 *  dereferenced from the vault HERE and never leaves the server. */
export function airflowConnFrom(c: Connection): AirflowConn {
  const secret = getSecretServerSide(c.secretRef) ?? undefined;
  return {
    baseUrl: c.endpoint,
    authType: c.airflow?.authType ?? 'bearer',
    username: c.airflow?.username,
    secret,
    fetchImpl: fetch,
    timeoutMs: 4000,
  };
}

/** Resolve a specific `airflow` connection the caller may see (id from the UI/MCP).
 *  Throws 404 for an unseeable id (no existence leak); 400 for the wrong type. */
export async function resolveAirflow(connId: string, user: CurrentUser): Promise<Connection> {
  const c = await getConnectionForUser(connId, user); // DLS guard (404)
  if (c.template !== 'airflow') {
    const e = new Error('Not an Apache Airflow connection') as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  return c;
}

/** True when this DAG may be triggered — either no allowlist is set (any DAG) or the
 *  DAG id is on the connection's non-secret allowlist. Bounds `trigger_dag`. */
export function airflowDagAllowed(c: Connection, dagId: string): boolean {
  const allow = c.airflow?.dagAllowlist;
  if (!allow || allow.length === 0) return true;
  return allow.includes(dagId);
}
