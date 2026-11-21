/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Per-agent-system trace statistics from the Langfuse Metrics API.
 * USER STORY: As an agentic engineer I want each agent system's p50/p95 latency, trace count, tokens
 *             and cost over a window, computed by Langfuse over its own traces.
 * ARCHITECTURE:
 *   - `GET /api/public/metrics?query=<json>` (https://langfuse.com/docs/metrics/features/metrics-api):
 *     view `traces`, dimension `sessionId`, metrics count · latency p50/p95 · totalTokens sum ·
 *     totalCost sum, filter `sessionId any of [system:<id>…]` — a run's session is `system:<id>`
 *     (core/infra/trace-port.ts `runSessionId`). The OS asks only for the systems the caller may see.
 *   - Latency is milliseconds as Langfuse reports it; `totalCost` null stays null (no price known).
 *   - No systems → no request. Unreachable / 401 → ok:false, never an empty success. Read-only.
 */
import { config } from '@core/kernel/config';
import type { Fetched } from '../_contract';
import { failed, fetched, readJson } from '../health/http';

export type SystemTraceStats = { systemId: string; traces: number; p50Ms: number | null; p95Ms: number | null; tokens: number; costUsd: number | null };

type Row = { sessionId?: string; count_count?: string | number; p50_latency?: number | string | null; p95_latency?: number | string | null; sum_totalTokens?: string | number | null; sum_totalCost?: string | number | null };

const SESSION = 'system:';
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export async function systemTraceStats(
  systemIds: readonly string[],
  opts: { from: Date; to: Date; base?: string; publicKey?: string; secretKey?: string; timeoutMs?: number },
): Promise<Fetched<Map<string, SystemTraceStats>>> {
  if (systemIds.length === 0) return fetched(new Map());
  const publicKey = opts.publicKey ?? config.langfusePublicKey;
  const secretKey = opts.secretKey ?? config.langfuseSecretKey;
  if (!publicKey || !secretKey) return failed('unauthorized', 'Langfuse API keys are not configured');
  const query = {
    view: 'traces',
    dimensions: [{ field: 'sessionId' }],
    metrics: [
      { measure: 'count', aggregation: 'count' },
      { measure: 'latency', aggregation: 'p50' },
      { measure: 'latency', aggregation: 'p95' },
      { measure: 'totalTokens', aggregation: 'sum' },
      { measure: 'totalCost', aggregation: 'sum' },
    ],
    filters: [{ column: 'sessionId', operator: 'any of', value: systemIds.map((id) => `${SESSION}${id}`), type: 'stringOptions' }],
    fromTimestamp: opts.from.toISOString(),
    toTimestamp: opts.to.toISOString(),
  };
  const r = await readJson<{ data?: Row[] }>(`${opts.base ?? config.langfuseUrl}/api/public/metrics?query=${encodeURIComponent(JSON.stringify(query))}`, {
    headers: { authorization: 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64') },
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  if (!r.ok) return r;
  if (!Array.isArray(r.value.data)) return failed('invalid', 'Langfuse metrics answer has no data array');
  const asked = new Set(systemIds);
  const out = new Map<string, SystemTraceStats>();
  for (const row of r.value.data) {
    const id = typeof row.sessionId === 'string' && row.sessionId.startsWith(SESSION) ? row.sessionId.slice(SESSION.length) : null;
    if (!id || !asked.has(id)) continue;
    out.set(id, { systemId: id, traces: num(row.count_count) ?? 0, p50Ms: num(row.p50_latency), p95Ms: num(row.p95_latency), tokens: num(row.sum_totalTokens) ?? 0, costUsd: num(row.sum_totalCost) });
  }
  return { ok: true, value: out, at: r.at };
}
