/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';

/**
 * Reachability of the metric read path's irreplaceable dependency. Every metric read
 * (explorer, dashboards, the agent `metrics` tool, the metric Build) serves as governed
 * Trino SQL over the gold mart, so the probe targets TRINO: a down Trino must report
 * metrics as unavailable (honesty gate) rather than fabricate a number. Server-only.
 */
export async function liveMetricsReachable(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`http://${config.trinoHost}:${config.trinoPort}/v1/info`, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
