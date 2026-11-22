/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { opaHeaders } from '@core/adapters/opa/client';
import 'server-only';
import { config } from '@core/kernel/config';
import { serviceBearerHeader } from '@core/infra/service-bearer';
import { recordObservation } from '@core/infra/langfuse';
import type { Role } from '@core/kernel/session';
import { decisionMeta, type DecisionMeta } from '@core/infra/opa-decision';
import { trinoClientTags, trinoSource, type TrinoRoute } from '@core/infra/trino-source';
import { opaDecide } from '@core/adapters/opa/client';

export type { TrinoRoute } from '@core/infra/trino-source';

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
 *   3. One Langfuse `tool` observation per call, through the one writer (`core/infra/langfuse.ts`).
 *
 * This is the seam the data golden path leans on: because the agent reads the
 * same governed metric + the same Iceberg mart as the dashboards, the numbers can't drift.
 */

export type ToolName = 'metrics' | 'query' | 'ask' | 'talk';

/** `decisionId`/`policyRev` are set when OPA answered (see opa-decision.ts). */
export type Authz = { allowed: boolean; policy: 'opa-allow' | 'opa-deny' | 'opa-unreachable' } & DecisionMeta;

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
/**
 * A WRITE decision: one named boolean rule of `agentic.authz`, evaluated on the caller's facts (role,
 * domains, the target's tier and owner). Unlike the tool grant it is NEVER fail-open: an OPA that
 * does not answer denies, whatever `OPA_FAIL_OPEN` says.
 */
export type WriteDecision = { rule: 'data_version_write' | 'workflow_write'; input: Record<string, unknown> };

/**
 * Test seam for the workflow write door (`agentic.authz.workflow_write`). Under `node --test` ONLY
 * (`NODE_TEST_CONTEXT` is set by the test runner and by nothing in production), a function on a
 * well-known global symbol stands in for the policy, so the many suites that exercise the workflow
 * tools as a permitted user need not run an OPA. `scripts/test-setup.mjs` installs an allowing one;
 * the tests of the door itself remove it and exercise the real path. Returns undefined in production.
 */
export function workflowWriteTestGate(): ((op: string, user: unknown, workflow: unknown) => unknown) | undefined {
  if (!process.env.NODE_TEST_CONTEXT) return undefined;
  const g = (globalThis as Record<symbol, unknown>)[Symbol.for('soa.test.workflowWriteGate')];
  return typeof g === 'function' ? (g as (op: string, user: unknown, workflow: unknown) => unknown) : undefined;
}

export async function authorize(principal: string, tool: string, write?: WriteDecision): Promise<Authz> {
  if (write) {
    const r = await opaDecide(`agentic/authz/${write.rule}`, { ...write.input, principal, tool }, 2500);
    if (!r.ok) return { allowed: false, policy: 'opa-unreachable' };
    const allowed = r.value.defined && r.value.value === true;
    return { allowed, policy: allowed ? 'opa-allow' : 'opa-deny' };
  }
  const unreachable: Authz = { allowed: config.opaFailOpen, policy: 'opa-unreachable' };
  const res = await withTimeout(`${config.opaUrl}/v1/data/agentic/authz/allow`, {
    method: 'POST',
    headers: opaHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ input: { principal, tool } }),
  });
  if (!res) return unreachable;
  try {
    const data = (await res.json()) as { result?: unknown };
    const allowed = Boolean(data?.result);
    return { allowed, policy: allowed ? 'opa-allow' : 'opa-deny', ...(await decisionMeta(data)) };
  } catch {
    return unreachable;
  }
}

/**
 * Langfuse record of a governed data tool call, through the one writer (`core/infra/langfuse.ts`):
 * a `tool` observation inside the active trace when there is one, otherwise its own trace.
 * Returns whether it was handed to the exporter.
 */
export async function trace(event: {
  principal: string;
  tool: ToolName;
  input: unknown;
  output: unknown;
}): Promise<boolean> {
  return recordObservation({
    name: `data.${event.tool}`,
    asType: 'tool',
    input: event.input,
    output: event.output,
    metadata: { principal: event.principal, tool: event.tool },
    tags: ['data-golden-path', `tool:${event.tool}`],
  });
}

// -------------------------------------------------------------- query-tool ----

export type QueryResult = {
  engine: string;
  tables: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
  /** True when the query-tool clipped the result at its `QUERY_MAX_ROWS` ceiling. The rows are
   *  the FIRST n, not a sample — a consumer that aggregates them must say so (B4-review E-1). */
  truncated?: boolean;
  /** The ceiling that clipped it, when truncated. */
  rowLimit?: number;
  /** The query-tool's own sentence about the truncation, for a surface to show verbatim. */
  message?: string;
};

export async function queryRun(
  sql: string,
  principal: string | undefined,
  route: TrinoRoute,
  schema?: string,
): Promise<QueryResult> {
  // principal is forwarded so Trino's OPA plugin governs row/column for the right
  // domain identity (the same principal OPA gates tool access on). schema (optional)
  // sets the session schema so an unqualified query targets the caller's own domain
  // instead of the query-tool's fixed default — the Catalog passes the caller's domain.
  // `route` becomes Trino's `source` + client tags, which select the resource group
  // `global.domains.<domain>.<user>` (core/infra/trino-source.ts, design 06 §5.5).
  const body: Record<string, unknown> = { sql, source: trinoSource(route), client_tags: trinoClientTags(route) };
  if (principal) body.principal = principal;
  if (schema) body.schema = schema;
  // 8 s bounds OUR WAIT, and nothing else (B4-review E-1): an abort here ends this fetch, it does
  // not end the query. What ends the query is the query-tool's `QUERY_MAX_RUN_TIME` session
  // property (60 s by default, chart-wired), and what bounds the payload is its `QUERY_MAX_ROWS`.
  // Before those existed, a slow read was orphaned on the cluster with nobody waiting for it.
  const res = await withTimeout(
    `${config.queryToolUrl}/query`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...serviceBearerHeader() },
      body: JSON.stringify(body),
    },
    8000,
  );
  // The same words every caller already classifies on, plus what an 8 s wait CAN mean: a slow
  // query is still running on the cluster (QUERY_MAX_RUN_TIME ends it), so "down" is not certain.
  if (!res) throw new Error('Could not reach query-tool within 8 s — it may be down, or the query is slow and still running on the cluster');
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
    // Truncation is never dropped on the floor here: a caller that renders rows must be able to
    // say "the first n", and `query_data`'s MCP payload carries it through.
    ...(data.truncated === true ? { truncated: true } : {}),
    ...(typeof data.row_limit === 'number' ? { rowLimit: data.row_limit } : {}),
    ...(typeof data.message === 'string' && data.truncated === true ? { message: data.message } : {}),
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

/** The write path's resource-group route: the target domain when the caller names it, else the
 *  identity's first domain (core/infra/trino-source.ts). */
export function executeRoute(identity: ExecuteIdentity, surface: string, targetDomain?: string): TrinoRoute {
  return { domain: targetDomain ?? identity.domains[0] ?? '', surface };
}

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
  route: TrinoRoute,
  schema?: string,
  // Interactive default stays 15s; long-running callers (the scheduled-sync
  // executor — config.syncStatementTimeoutMs) pass their own budget explicitly.
  timeoutMs = 15000,
  /** `'domain-delete'`: the admin delete-domain run — the only caller the query-tool lets
   *  `DROP SCHEMA` (images/extensions/query-tool/execute_guard.py). */
  purpose?: 'domain-delete',
): Promise<ExecuteResult> {
  const body: Record<string, unknown> = {
    sql,
    principal: identity.principal,
    uid: identity.uid,
    domains: identity.domains,
    role: identity.role,
    source: trinoSource(route),
    client_tags: trinoClientTags(route),
  };
  if (schema) body.schema = schema;
  if (purpose) body.purpose = purpose;
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

