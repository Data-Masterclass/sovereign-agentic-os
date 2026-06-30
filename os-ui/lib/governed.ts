/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';

/**
 * Governed data-tool spine. Every data access an agent makes — the Cube `metrics`
 * tool and the Trino `query` tool — funnels through here so the SAME policy +
 * audit applies whether the caller is the dashboard, an agent, or a UI panel.
 * Three concerns:
 *
 *   1. OPA authorization (default-deny). We ask the live decision API whether the
 *      principal may call the tool. If OPA is unreachable (off locally) we fail
 *      OPEN with an explicit `policy: 'opa-unreachable'` marker so the teaching
 *      flow still runs but the report is honest about it.
 *   2. Execution against the SAME governed backends the BI layer uses — Cube for
 *      metrics, the query-tool for ad-hoc SQL over the Iceberg marts.
 *   3. Best-effort Langfuse trace so every tool call is auditable in Monitoring.
 *
 * This is the seam the data golden path leans on: because the agent reads the
 * same Cube metric + the same Iceberg mart as Superset, the numbers can't drift.
 */

export type ToolName = 'metrics' | 'query';

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

/** Ask OPA whether `principal` may call `tool`. Fail-open + marked when OPA is off. */
export async function authorize(principal: string, tool: string): Promise<Authz> {
  const res = await withTimeout(`${config.opaUrl}/v1/data/agentic/authz/allow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { principal, tool } }),
  });
  if (!res) return { allowed: true, policy: 'opa-unreachable' };
  try {
    const data = (await res.json()) as { result?: unknown };
    const allowed = Boolean(data?.result);
    return { allowed, policy: allowed ? 'opa-allow' : 'opa-deny' };
  } catch {
    return { allowed: true, policy: 'opa-unreachable' };
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

// ----------------------------------------------------------------- Cube -------

export type CubeQuery = {
  measures?: string[];
  dimensions?: string[];
  timeDimensions?: { dimension: string; granularity?: string; dateRange?: string[] }[];
  filters?: { member: string; operator: string; values: string[] }[];
  order?: Record<string, 'asc' | 'desc'>;
  limit?: number;
};

export type CubeResult = { rows: Record<string, unknown>[]; annotation: Record<string, unknown> };

export async function cubeLoad(
  query: CubeQuery,
  opts: { securityContext?: Record<string, unknown> } = {},
): Promise<CubeResult> {
  // R3 (data-policy-compiler.md): when an agent/dashboard resolves a metric, the
  // per-user securityContext propagates to Cube so its row-level security applies —
  // never a shared service identity. Cube reads it from the request token; locally
  // (no JWT signer) it is passed as a header a dev Cube can map, and is a no-op otherwise.
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (opts.securityContext) headers['x-cube-security-context'] = JSON.stringify(opts.securityContext);
  const res = await withTimeout(
    `${config.cubeUrl}/cubejs-api/v1/load`,
    { method: 'POST', headers, body: JSON.stringify({ query }) },
    8000,
  );
  if (!res) throw new Error('Could not reach Cube');
  const text = await res.text();
  if (!res.ok) throw new Error(`Cube ${res.status}: ${text.slice(0, 240)}`);
  const data = JSON.parse(text);
  return {
    rows: Array.isArray(data?.data) ? data.data : [],
    annotation: (data?.annotation ?? {}) as Record<string, unknown>,
  };
}

/** Resolve a single scalar measure from Cube (the metrics tool's core move). */
export async function cubeScalar(query: CubeQuery, measure: string): Promise<number | null> {
  const { rows } = await cubeLoad(query);
  if (rows.length === 0) return null;
  // Sum across returned rows so a grouped query still yields the total.
  let total = 0;
  for (const r of rows) {
    const v = Number(r[measure]);
    if (!Number.isNaN(v)) total += v;
  }
  return total;
}

// -------------------------------------------------------------- query-tool ----

export type QueryResult = {
  engine: string;
  tables: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};

export async function queryRun(sql: string, principal?: string): Promise<QueryResult> {
  // principal is forwarded so Trino's OPA plugin governs row/column for the right
  // domain identity (the same principal OPA gates tool access on).
  const res = await withTimeout(
    `${config.queryToolUrl}/query`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(principal ? { sql, principal } : { sql }),
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

// ------------------------------------------------- Sales worked-example facts --

/**
 * The canonical Sales data product (data-golden-path.md worked example). Both the
 * Cube metric and the Iceberg mart are seeded from the SAME 10 Q1-2026 orders, so
 * the metrics tool and the query tool MUST agree. Centralised here so the parity
 * proof, the Sales agent, and the UI all reference one source of truth.
 */
export const SALES = {
  mart: 'mart_sales',
  cube: 'mart_sales',
  revenueMeasure: 'mart_sales.revenue',
  regionDim: 'mart_sales.region',
  dateDim: 'mart_sales.order_date',
  netAmountColumn: 'net_amount',
  // "Last quarter" relative to mid-2026 = Q1 2026 (the data's range).
  lastQuarter: { label: 'Q1 2026', start: '2026-01-01', end: '2026-03-31' },
} as const;
