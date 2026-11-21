/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    PromQL instant query against VictoriaMetrics (`GET /api/v1/query`).
 * USER STORY: As an operator I want the Monitoring tab's resource-pressure numbers to be exactly what
 *             VictoriaMetrics answers for a PromQL expression.
 * ARCHITECTURE: the documented query API (https://docs.victoriametrics.com/victoriametrics/url-examples/
 *   #apiv1query): `{status:"success", data:{resultType:"vector", result:[{metric, value:[t,"v"]}]}}`.
 *   A PromQL error (`status:"error"`, HTTP 422) or an unreachable store is ok:false — never an empty
 *   success. Read-only.
 */
import { config } from '@core/kernel/config';
import type { Fetched } from '../_contract';
import { failed, fetched, readHttp } from '../health/http';

export type PromSample = { metric: Record<string, string>; value: number; at: number };

type Body = { status?: string; error?: string; data?: { resultType?: string; result?: { metric?: Record<string, string>; value?: [number, string] }[] } };

export async function promInstant(query: string, opts: { base?: string; timeoutMs?: number } = {}): Promise<Fetched<PromSample[]>> {
  const base = opts.base ?? config.victoriaMetricsUrl;
  const r = await readHttp(`${base}/api/v1/query?query=${encodeURIComponent(query)}`, { timeoutMs: opts.timeoutMs ?? 4_000 });
  if (!r.ok) return r;
  let body: Body;
  try {
    body = JSON.parse(r.value.text) as Body;
  } catch {
    return failed('invalid', `VictoriaMetrics did not answer JSON: ${r.value.text.slice(0, 120)}`);
  }
  if (body.status !== 'success') return failed('invalid', `PromQL error: ${body.error ?? 'unknown'}`);
  if (body.data?.resultType !== 'vector') return failed('invalid', `expected an instant vector, got ${body.data?.resultType}`);
  return fetched(
    (body.data.result ?? []).map((s) => ({ metric: s.metric ?? {}, value: Number(s.value?.[1]), at: Number(s.value?.[0]) * 1000 })).filter((s) => Number.isFinite(s.value)),
  );
}
