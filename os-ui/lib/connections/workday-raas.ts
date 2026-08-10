/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide, isEgressAllowed } from '@/lib/infra/secrets';
import { serviceBearerHeader } from '@/lib/infra/service-bearer';
import { fetchWithBackoff } from '@/lib/connections/retry';
import { deleteBatchSql, type SyncTarget } from '@/lib/data/sync-sql';
import type { ExecuteIdentity } from '@/lib/infra/governed';
import { config } from '@/lib/core/config';

/**
 * Workday RaaS (Reports-as-a-Service) client — the server-only bridge to a customer's
 * Workday tenant (operational-system-connections.md, Phase 4/5, decision 4). RaaS exposes
 * each CUSTOM REPORT as a REST endpoint returning `?format=json`. There is NO cheap global
 * describe, so v1 is honest about it: the ADMIN registers the report paths (the wizard says
 * so plainly), and EACH registered report IS one entity row in the catalog.
 *
 * AUTH (v1): ISU (Integration System User) Basic auth — the ONE vaulted credential is
 * `<isu_user>:<password>` (split server-side, never on the record). Refresh-token OAuth is
 * a later variant on the existing per-user OAuth machinery — v1 stays simple Basic.
 *
 * DISCOVERY: for each configured report, fields are INFERRED from the FIRST PAGE of
 * `?format=json` (sampled) and labeled "inferred from a sample" in the describe payload.
 * Record counts are OMITTED — there is no honest cheap count in RaaS.
 *
 * SYNC: full-refresh-only by default. IF the admin configured an incremental date-prompt
 * parameter on the report, a window on it is applied (and the cursor chip says so honestly);
 * else full refresh. Slice streams to the data-runner /ingest-rows like the other operational
 * runners. True per-entity incremental entity sync arrives with the SOAP WWS integration (v2)
 * — stated plainly in the install guide and template description.
 *
 * Follows the Connector Design Standard (§1.2 pure/bridge split, §3 write-only secrets,
 * §5 honest degradation) exactly like salesforce.ts / odata/client.ts.
 */

export type WdFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type WdRead<T> = { ok: true; data: T } | { ok: false; reason: string };

/** ONE registered RaaS report — the admin pastes/manages these; each is a catalog entity.
 *  `key` is a stable slug used as the entity/table name; `path` is the report URL (relative
 *  to the tenant RaaS base, or absolute); `incrementalParam`, when set, is the report date
 *  PROMPT the admin exposed for an incremental window. */
export type WorkdayReport = {
  key: string;
  path: string;
  label?: string;
  /** The report's date-prompt query parameter name for an incremental window (optional). */
  incrementalParam?: string;
};

/** The per-connection client config. Secret fields never leave the server. */
export type WdConn = {
  /** The tenant RaaS base URL (no trailing slash). */
  baseUrl: string;
  user?: string;
  pass?: string;
  reports: WorkdayReport[];
  fetchImpl: WdFetch;
  timeoutMs?: number;
};

/** Split the ONE vaulted credential `<isu_user>:<password>` on the FIRST colon. */
export function splitWorkdayCredential(raw: string | null | undefined): { user: string; pass: string } | null {
  const s = (raw ?? '').trim();
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { user: s.slice(0, i), pass: s.slice(i + 1) };
}

/** A report KEY safe to use as an entity/table identifier (letters/digits/underscore). */
export function safeReportKey(key: string): string {
  const s = (key ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw Object.assign(new Error(`workday: unsafe report key '${key ?? ''}'`), { status: 400 });
  }
  return s;
}

function base(conn: WdConn): string {
  return conn.baseUrl.replace(/\/$/, '');
}

/** Build the ABSOLUTE URL for a report, forcing `format=json` and applying the incremental
 *  window on the report's configured date prompt when both a param + watermark are set. */
export function reportUrl(conn: WdConn, report: WorkdayReport, window?: { from?: string | null; to?: string | null }): string {
  const raw = report.path.trim();
  const abs = raw.includes('://') ? raw : `${base(conn)}/${raw.replace(/^\//, '')}`;
  const u = new URL(abs);
  u.searchParams.set('format', 'json');
  if (report.incrementalParam && window?.from) {
    // The admin's date-prompt param name carries the incremental lower bound. Workday
    // report prompts accept an ISO date/datetime; the exact prompt semantics are the
    // report's own — we only pass the value the admin scoped.
    u.searchParams.set(report.incrementalParam, window.from);
  }
  return u.toString();
}

async function withTimeout(conn: WdConn, url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 60000);
  try {
    return await fetchWithBackoff(url, { ...init, signal: ctrl.signal, cache: 'no-store' }, (u, i) => conn.fetchImpl(u, i));
  } finally {
    clearTimeout(timer);
  }
}

function basicHeader(conn: WdConn): WdRead<Record<string, string>> {
  if (!conn.user || !conn.pass) return { ok: false, reason: 'credential must be <isu_user>:<password> for Workday ISU Basic auth' };
  const b64 = Buffer.from(`${conn.user}:${conn.pass}`).toString('base64');
  return { ok: true, data: { authorization: `Basic ${b64}` } };
}

/** RaaS returns `{ Report_Entry: [ {…}, … ] }` for `format=json`. Extract that array
 *  (tolerant of a bare array or a single wrapping object key). */
export function extractReportRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.Report_Entry)) return o.Report_Entry as Record<string, unknown>[];
    // Fallback: the single wrapping key whose value is an array.
    for (const v of Object.values(o)) if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

/** Fetch one report's rows (RaaS is not paginated in the query API — it returns the full
 *  result set for the report). Never throws — honest reason on failure. */
export async function fetchReport(conn: WdConn, report: WorkdayReport, window?: { from?: string | null }): Promise<WdRead<Record<string, unknown>[]>> {
  const auth = basicHeader(conn);
  if (!auth.ok) return auth;
  try {
    const res = await withTimeout(conn, reportUrl(conn, report, window), {
      method: 'GET',
      headers: { ...auth.data, accept: 'application/json' },
    });
    if (res.status === 429) return { ok: false, reason: `Workday rate-limited; retry after ${res.headers.get('retry-after') ?? '?'}s` };
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `Workday RaaS ${res.status}: ${text.slice(0, 240)}` };
    try {
      return { ok: true, data: extractReportRows(JSON.parse(text)) };
    } catch {
      return { ok: false, reason: 'Workday RaaS returned a non-JSON body (is the report shared for RaaS + format=json?)' };
    }
  } catch {
    return { ok: false, reason: 'Workday tenant unreachable' };
  }
}

/** Fields INFERRED from a sample row — flat scalars only (Bronze columns). Nested objects/
 *  arrays are RaaS sub-report structures, skipped like the OData nav skip. */
export function inferFields(rows: Record<string, unknown>[]): { name: string; type: string; label: string }[] {
  const first = rows.find((r) => r && typeof r === 'object');
  if (!first) return [];
  const out: { name: string; type: string; label: string }[] = [];
  for (const [k, v] of Object.entries(first)) {
    if (v !== null && typeof v === 'object') continue; // nested sub-report — not a flat column
    const type = v === null ? 'unknown' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string';
    out.push({ name: k, type, label: `${k} (inferred from a sample)` });
  }
  return out;
}

// ---------------------------------------------------------- server bridge -------

/** Build the client config from a Connection RECORD (health-probe path). */
export function workdayConnFrom(c: Connection): WdConn {
  const cred = splitWorkdayCredential(getSecretServerSide(c.secretRef));
  return {
    baseUrl: c.endpoint,
    user: cred?.user,
    pass: cred?.pass,
    reports: c.workday?.reports ?? [],
    fetchImpl: (u, i) => fetch(u, i),
  };
}

/** Resolve a Workday connection UNDER THE CALLER'S IDENTITY (DLS 404), enforce egress. */
export async function resolveWorkday(connId: string, user: CurrentUser): Promise<WdConn> {
  const { getConnectionForUser } = await import('@/lib/connections/store');
  const c = await getConnectionForUser(connId, user);
  if (c.template !== 'workday-raas') {
    throw Object.assign(new Error(`Connection ${connId} is not a Workday RaaS connection`), { status: 400 });
  }
  const egress = isEgressAllowed(c.endpoint);
  if (!egress.allowed) {
    throw Object.assign(
      new Error(`Egress to ${egress.host} is not allowlisted — request egress approval for this Workday tenant first`),
      { status: 403 },
    );
  }
  return workdayConnFrom(c);
}

/** Report discovery — the configured reports ARE the entities (no global describe). The
 *  SAME response shape a warehouse discover returns (schemas/tables). */
export async function discoverWorkdayReports(
  connId: string,
  user: CurrentUser,
): Promise<{ ok: boolean; schemas: string[]; tables: string[]; schema: string | null; detail: string }> {
  const conn = await resolveWorkday(connId, user);
  const reports = conn.reports;
  return {
    ok: true,
    schemas: ['workday'],
    schema: 'workday',
    tables: reports.map((r) => r.key),
    detail:
      reports.length > 0
        ? `${reports.length} configured RaaS report(s) — each report IS one entity (no global describe in Workday RaaS).`
        : 'No RaaS reports configured yet — add report URLs on this connection to expose them as entities.',
  };
}

/** Describe ONE report's fields by SAMPLING its first page — labeled "inferred from a
 *  sample". Resolves AS the caller (DLS). Throws the honest reason on an unreachable tenant. */
export async function describeWorkdayReport(
  connId: string,
  user: CurrentUser,
  reportKey: string,
): Promise<{ name: string; type: string; label: string }[]> {
  const conn = await resolveWorkday(connId, user);
  const report = conn.reports.find((r) => r.key.toLowerCase() === reportKey.trim().toLowerCase());
  if (!report) throw Object.assign(new Error(`report '${reportKey}' is not configured on this connection`), { status: 404 });
  const rows = await fetchReport(conn, report);
  if (!rows.ok) throw Object.assign(new Error(rows.reason), { status: 502 });
  return inferFields(rows.data);
}

/** The honest health probe: a REAL sample fetch of the FIRST configured report (or an
 *  honest "no reports configured" when the admin hasn't added any). Never fakes green. */
export async function workdayHealth(c: Connection): Promise<{ ok: boolean; mode: 'live' | 'offline'; detail: string }> {
  const conn = workdayConnFrom(c);
  if (conn.reports.length === 0) {
    return { ok: false, mode: 'offline', detail: 'No RaaS reports configured — add a report URL, then re-test.' };
  }
  const rows = await fetchReport(conn, conn.reports[0]);
  if (!rows.ok) return { ok: false, mode: 'offline', detail: rows.reason };
  return { ok: true, mode: 'live', detail: `Sampled report '${conn.reports[0].key}' (${rows.data.length} row(s) in the sample).` };
}

/**
 * REAL, thin READ executor for an ALREADY-ALLOWED Workday RaaS tool (C2). Both tools are
 * Read; the governance gate has passed upstream in `callConnectionTool`. Never throws —
 * failures degrade to `{ ok:false, reason }`. The ISU credential is dereferenced from the
 * vault inside `workdayConnFrom` and never logged/returned.
 *
 *   • workday_list_reports → the configured reports (each IS an entity — no live call).
 *   • workday_read_report  → a REAL RaaS fetch of one configured report's rows.
 */
export async function executeWorkdayTool(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = workdayConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false as const, reason });
  if (tool === 'workday_list_reports') {
    return { connection: c.name, ok: true as const, reports: conn.reports.map((r) => r.key) };
  }
  if (tool === 'workday_read_report') {
    const key = String(args.report ?? args.reportKey ?? '');
    if (!key) return fail('workday_read_report needs a report key');
    const report = conn.reports.find((r) => r.key.toLowerCase() === key.trim().toLowerCase());
    if (!report) return fail(`report '${key}' is not configured on this connection`);
    const rows = await fetchReport(conn, report);
    if (!rows.ok) return fail(rows.reason);
    return { connection: c.name, ok: true as const, report: report.key, rows: rows.data };
  }
  return fail(`Unknown Workday tool: ${tool}`);
}

// -------------------------------------------------- API-batch sync execution ----

export type WorkdaySliceArgs = {
  connectionId: string;
  owner: CurrentUser;
  /** The report KEY to sync (sync.source.table). */
  report: string;
  mode: 'full-refresh' | 'append';
  watermark: string | null;
  datasetSlug: string;
  target: SyncTarget;
  identity: ExecuteIdentity;
  execute: (sql: string, identity: ExecuteIdentity) => Promise<{ rowsAffected: number | null }>;
  mkBatchId: (highWatermark: string) => string;
  window?: { highWatermark: string } | null;
  onWindow?: (highWatermark: string, batchId: string) => void;
  startedAt: string;
  // ---- test seams ----
  resolve?: (connId: string, owner: CurrentUser) => Promise<WdConn>;
  ingestUrl?: string;
  fetchImpl?: WdFetch;
};

async function postIngestRows(
  url: string,
  fetchImpl: WdFetch,
  payload: { principal: string; dataset: string; rows: Record<string, unknown>[]; mode: 'append' | 'replace' },
): Promise<void> {
  const res = await fetchImpl(`${url}/ingest-rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...serviceBearerHeader() },
    body: JSON.stringify(payload),
    cache: 'no-store',
  } as RequestInit);
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new Error(`data-runner /ingest-rows ${res.status}: ${data.error ?? 'failed'}`);
  }
}

/** Flatten one report row for Bronze: drop nested sub-report objects/arrays, stamp lineage. */
export function flattenReportRow(row: Record<string, unknown>, loadedAt: string, batchId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && typeof v === 'object') continue;
    out[k] = v;
  }
  out._loaded_at = loadedAt;
  out._batch_id = batchId;
  return out;
}

/**
 * Run ONE Workday RaaS sync slice. FULL-REFRESH-ONLY by default: RaaS returns the full
 * report result set in one response, so a run replaces the Bronze copy. WHEN the report
 * carries an admin-configured incremental date prompt AND the run is `append` with a
 * watermark, the window is applied on that prompt (an incremental window, honestly
 * scoped) — else `append` against a promptless report fails the run honestly. No cheap
 * high-watermark probe exists in RaaS, so an incremental window uses the RUN START as its
 * upper bound cursor (the next run windows from here).
 */
export async function runWorkdaySlice(
  a: WorkdaySliceArgs,
): Promise<{ rowsAffected: number | null; batchId?: string; highWatermark: string | null }> {
  const conn = await (a.resolve ?? resolveWorkday)(a.connectionId, a.owner);
  const fetchImpl = a.fetchImpl ?? conn.fetchImpl;
  const client: WdConn = { ...conn, fetchImpl };
  const key = safeReportKey(a.report);
  const report = client.reports.find((r) => r.key.toLowerCase() === key.toLowerCase());
  if (!report) throw new Error(`report '${key}' is not configured on this connection`);

  const canIncrement = Boolean(report.incrementalParam);
  const firstLoad = a.mode === 'full-refresh' || a.watermark === null;
  if (a.mode === 'append' && !canIncrement) {
    throw new Error(
      `workday: report '${key}' has no configured date prompt — incremental sync is not supported; use full-refresh`,
    );
  }

  // No cheap max-cursor probe in RaaS. An incremental window uses the RUN START as its
  // high watermark (the next run windows from here); a full refresh has none.
  const highWatermark = !firstLoad && canIncrement ? (a.window?.highWatermark ?? a.startedAt) : null;
  const batchId = a.mkBatchId(highWatermark ?? a.startedAt);

  if (!firstLoad) {
    a.onWindow?.(highWatermark ?? a.startedAt, batchId);
    await a.execute(deleteBatchSql(a.target, batchId), a.identity);
  }

  // Fetch the report (windowed on the date prompt for an incremental run).
  const rows = await fetchReport(client, report, firstLoad ? undefined : { from: a.watermark });
  if (!rows.ok) throw new Error(rows.reason);

  const ingestUrl = a.ingestUrl ?? config.dataRunnerUrl;
  const stamped = rows.data.map((r) => flattenReportRow(r, a.startedAt, batchId));
  if (firstLoad && stamped.length === 0) {
    return { rowsAffected: 0, highWatermark: null };
  }
  await postIngestRows(ingestUrl, fetchImpl, {
    principal: a.owner.id,
    dataset: a.datasetSlug,
    rows: stamped,
    mode: firstLoad ? 'replace' : 'append',
  });
  return { rowsAffected: stamped.length, batchId, highWatermark };
}
