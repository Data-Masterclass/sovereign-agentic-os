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
