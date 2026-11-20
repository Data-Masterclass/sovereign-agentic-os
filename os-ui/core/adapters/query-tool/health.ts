/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The query-tool health adapter: what the RUNNING query-tool build supports
 * USER STORY: As the admin starting a domain delete I want it refused up front when the deployed
 *             query-tool is too old for it, instead of failing halfway through.
 * ARCHITECTURE:
 *   - `GET /health` (images/extensions/query-tool/app.py); `capabilities` lists the write-path
 *     features of that build. Returns the `Fetched` contract; never throws.
 */
import { config } from '@core/kernel/config';
import type { Fetched } from '@core/adapters/_contract';

const now = () => new Date().toISOString();

export async function queryToolCapabilities(timeoutMs = 5000): Promise<Fetched<string[]>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.queryToolUrl}/health`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: 'invalid', detail: `query-tool /health answered ${res.status}`, at: now() };
    const body = (await res.json()) as { capabilities?: unknown };
    const caps = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === 'string') : [];
    return { ok: true, value: caps, at: now() };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'unreachable', detail: `query-tool ${aborted ? 'timed out' : 'unreachable'} at /health`, at: now() };
  } finally {
    clearTimeout(timer);
  }
}
