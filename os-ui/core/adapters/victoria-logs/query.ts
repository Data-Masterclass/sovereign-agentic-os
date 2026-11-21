/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    LogsQL query against VictoriaLogs (`GET /select/logsql/query`).
 * USER STORY: As an operator I want error-log rates and OPA decision counts on the Monitoring tab to be
 *             exactly what VictoriaLogs answers for a LogsQL query.
 * ARCHITECTURE: the documented HTTP API (https://docs.victoriametrics.com/victorialogs/querying/
 *   #querying-logs): one JSON object per line; a `| stats …` pipe answers its result rows the same
 *   way (https://docs.victoriametrics.com/victorialogs/logsql/#stats-pipe). `start` is a LogsQL
 *   relative time (`1h`, `7d`) or an RFC 3339 timestamp. An error or an unreachable store is
 *   ok:false — never an empty success. Read-only.
 */
import { config } from '@core/kernel/config';
import type { Fetched } from '../_contract';
import { failed, fetched, readHttp } from '../health/http';

export type LogRow = Record<string, string>;

export async function logsQuery(query: string, opts: { base?: string; start?: string; limit?: number; timeoutMs?: number } = {}): Promise<Fetched<LogRow[]>> {
  const base = opts.base ?? config.victoriaLogsUrl;
  const qs = new URLSearchParams({ query });
  if (opts.start) qs.set('start', opts.start);
  if (opts.limit) qs.set('limit', String(opts.limit));
  const r = await readHttp(`${base}/select/logsql/query?${qs}`, { timeoutMs: opts.timeoutMs ?? 5_000 });
  if (!r.ok) return r;
  const rows: LogRow[] = [];
  for (const line of r.value.text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LogRow);
    } catch {
      return failed('invalid', `VictoriaLogs answered a line that is not JSON: ${line.slice(0, 120)}`);
    }
  }
  return fetched(rows);
}

/** A LogsQL string literal: `"…"` with `"` and `\` escaped. */
export function logsqlQuote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
