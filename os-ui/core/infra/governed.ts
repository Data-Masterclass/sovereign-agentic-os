/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { serviceBearerHeader } from '@core/infra/service-bearer';
import type { Role } from '@core/kernel/session';

/**
 * Governed data-tool spine. Every data access an agent makes — the `metrics` tool
 * and the Trino `query` tool — funnels through here so the SAME policy +
 * audit applies whether the caller is the dashboard, an agent, or a UI panel.
 * Three concerns:
 *
 *   1. OPA authorization (default-deny). We ask the live decision API whether the
 *      principal may call the tool. If OPA is unreachable/errors we FAIL CLOSED
 *      (deny) with an explicit `policy: 'opa-unreachable'` marker — consistent
 *      with the agent spine — so an OPA outage cannot silently open data authz.
 *      The offline-mock teaching flow can opt into fail-open with OPA_FAIL_OPEN=true.
 *   2. Execution against the SAME governed backend the BI layer uses — the
 *      query-tool (Trino) for metrics and ad-hoc SQL over the Iceberg marts.
 *   3. Best-effort Langfuse trace so every tool call is auditable in Monitoring.
 *
 * This is the seam the data golden path leans on: because the agent reads the
 * same governed metric + the same Iceberg mart as the dashboards, the numbers can't drift.
 */

export type ToolName = 'metrics' | 'query' | 'ask' | 'talk';

export type Authz = { allowed: boolean; policy: 'opa-allow' | 'opa-deny' | 'opa-unreachable' };

async function withTimeout(url: string, init: RequestInit, ms = 2500): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask OPA whether `principal` may call `tool`. Fail-CLOSED (deny) + marked when
 *  OPA is unreachable/errors, unless OPA_FAIL_OPEN is explicitly set for the
 *  offline-mock teaching flow. Aligns with the agent spine's default-deny. */
export async function authorize(principal: string, tool: string): Promise<Authz> {
  const unreachable: Authz = { allowed: config.opaFailOpen, policy: 'opa-unreachable' };
  const res = await withTimeout(`${config.opaUrl}/v1/data/agentic/authz/allow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { principal, tool } }),
  });
  if (!res) return unreachable;
  try {
    const data = (await res.json()) as { result?: unknown };
    const allowed = Boolean(data?.result);
    return { allowed, policy: allowed ? 'opa-allow' : 'opa-deny' };
  } catch {
    return unreachable;
  }
}

/** Fire-and-forget Langfuse trace of a governed tool call. Returns whether it landed. */
export async function trace(event: {
  principal: string;
  tool: ToolName;
  input: unknown;
  output: unknown;
}): Promise<boolean> {
  const id = `os-data-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const auth =
    'Basic ' +
    Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const body = {
    batch: [
      {
        id,
        type: 'trace-create',
        timestamp: new Date().toISOString(),
        body: {
          id,
          name: `data.${event.tool}`,
          metadata: { principal: event.principal, tool: event.tool },
          input: event.input,
          output: event.output,
          tags: ['data-golden-path', `tool:${event.tool}`],
        },
      },
    ],
  };
  const res = await withTimeout(`${config.langfuseUrl}/api/public/ingestion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  });
  return Boolean(res && res.ok);
}

// -------------------------------------------------------------- query-tool ----

export type QueryResult = {
  engine: string;
  tables: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};

export async function queryRun(sql: string, principal?: string, schema?: string): Promise<QueryResult> {
  // principal is forwarded so Trino's OPA plugin governs row/column for the right
  // domain identity (the same principal OPA gates tool access on). schema (optional)
  // sets the session schema so an unqualified query targets the caller's own domain
  // instead of the query-tool's fixed default — the Catalog passes the caller's domain.
  const body: Record<string, string> = { sql };
  if (principal) body.principal = principal;
  if (schema) body.schema = schema;
  const res = await withTimeout(
    `${config.queryToolUrl}/query`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...serviceBearerHeader() },
      body: JSON.stringify(body),
    },
    8000,
  );
  if (!res) throw new Error('Could not reach query-tool');
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`query-tool returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.error) throw new Error((data.error as string) ?? `query-tool ${res.status}`);
  return {
    engine: String(data.engine ?? 'trino'),
    tables: Array.isArray(data.tables) ? (data.tables as string[]) : [],
    columns: Array.isArray(data.columns) ? (data.columns as string[]) : [],
    rows: Array.isArray(data.rows) ? (data.rows as string[][]) : [],
    rowCount: typeof data.row_count === 'number' ? data.row_count : 0,
  };
}

// -------------------------------------------------- query-tool (WRITE path) ---

/**
 * The caller identity threaded to the governed WRITE endpoint. EVERY field is
 * derived SERVER-SIDE from the signed session (`requireUser()`), NEVER from the
 * request body — the same trust model as `queryRun`'s `principal`. Callers build
 * this from a `CurrentUser`:
 *   { principal: u.domains[0] ?? u.id, uid: u.id, domains: u.domains, role: u.role }
 * `principal` is the Trino session user Trino->OPA governs the CTAS reads on (so a
 * build can only read what the builder may read); `uid`/`domains`/`role` drive the
 * query-tool's write-target + role gate.
 */
export type ExecuteIdentity = {
  principal: string;
  uid: string;
  domains: string[];
  role: Role;
};

export type ExecuteResult = { ok: true; rowsAffected: number | null };

/**
 * Run a single governed WRITE (allowlisted DDL: CREATE SCHEMA / CTAS / DROP TABLE)
 * through the query-tool's `/execute`. The query-tool re-validates the statement
 * allowlist AND the target-schema/role gate before anything reaches Trino, and runs
 * it as `identity.principal`. Throws on any rejection (400/403) or Trino error,
 * surfacing the real message — mirrors `queryRun`'s honest-error contract. This is
 * the function the Silver/Gold/Publish tasks call; it does NOT build any UI.
 */
export async function executeRun(
  sql: string,
  identity: ExecuteIdentity,
  schema?: string,
  // Interactive default stays 15s; long-running callers (the scheduled-sync
  // executor — config.syncStatementTimeoutMs) pass their own budget explicitly.
  timeoutMs = 15000,
): Promise<ExecuteResult> {
  const body: Record<string, unknown> = {
    sql,
    principal: identity.principal,
    uid: identity.uid,
    domains: identity.domains,
    role: identity.role,
  };
  if (schema) body.schema = schema;
  const res = await withTimeout(
    `${config.queryToolUrl}/execute`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...serviceBearerHeader() },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!res) throw new Error('Could not reach query-tool');
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`query-tool returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.ok === false || data.error) {
    throw new Error((data.error as string) ?? `query-tool ${res.status}`);
  }
  return {
    ok: true,
    rowsAffected: typeof data.rowsAffected === 'number' ? data.rowsAffected : null,
  };
}

