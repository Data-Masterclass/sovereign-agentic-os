/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { cubeLoad, cubeScalar } from '@/lib/infra/governed';
import { type MetricCubeClient, type MetricLiveDeps } from './live.ts';

/**
 * The REAL fetch-backed Cube client for the live Metric build adapters. Server-only.
 * Reuses the governed Cube helpers (which already forward the per-user securityContext
 * to Cube — R3 — so RLS applies and never collapses to a service identity). Kept apart
 * from the pure live.ts so the adapters stay unit-testable; a network/HTTP failure
 * throws or returns falsy ⇒ the row reports ✗.
 */

async function withTimeout(url: string, ms = 2500): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function realMetricCube(): MetricCubeClient {
  return {
    async reload(_view, _schema) {
      // The Cube measures/views YAML is git-deployed (Forgejo → Cube), not hot-pushed;
      // the adapter confirms Cube has loaded a usable model. A 4xx/5xx/unreachable → ✗.
      const res = await withTimeout(`${config.cubeUrl}/cubejs-api/v1/meta`);
      if (!res || !res.ok) throw new Error(`Cube /meta not ready (${res?.status ?? 'unreachable'})`);
    },
    async resolveMeasure(member) {
      return cubeScalar({ measures: [member], limit: 1 }, member);
    },
    async explore(query, securityContext) {
      const { rows } = await cubeLoad(query, { securityContext });
      return { rows };
    },
  };
}

export function makeRealMetricClients(): MetricLiveDeps {
  return { cube: realMetricCube() };
}

/** Cube reachable? The metric build's irreplaceable dependency (the one live can't fake). */
export async function liveMetricsReachable(): Promise<boolean> {
  const res = await withTimeout(`${config.cubeUrl}/cubejs-api/v1/meta`, 2500);
  return Boolean(res && res.ok);
}
