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

/**
 * A newly-defined measure reaches Cube via the model-sync SIDECAR (polls os-ui's
 * /api/cube/models and writes .cube.yml Cube hot-reloads) — so for a few seconds after
 * define, Cube is UP but does NOT yet know the measure, and 400s with a "not found for
 * path" UserError. That's sync lag, not a real error: treat it as "not yet resolved"
 * (fail-soft), never a hard throw. Genuine errors still surface.
 */
export function isCubeSyncLag(e: unknown): boolean {
  return /not found for path|not found/i.test((e as Error)?.message ?? '');
}

export function realMetricCube(): MetricCubeClient {
  return {
    async reload(_view, _schema) {
      // LIVENESS CHECK ONLY. Cube's schema comes from (1) a ConfigMap seed of static models
      // at boot + (2) the model-sync sidecar that HTTP-polls os-ui's GET /api/cube/models
      // every few seconds and writes the .cube.yml files Cube hot-reloads. There is no
      // Forgejo→Cube path. So a freshly-defined measure only appears after the next sidecar
      // poll — this /meta probe confirms Cube is UP, not that it has THIS measure yet (the
      // resolveMeasure verify + fail-soft handle the sync gap). 4xx/5xx/unreachable → ✗.
      const res = await withTimeout(`${config.cubeUrl}/cubejs-api/v1/meta`);
      if (!res || !res.ok) throw new Error(`Cube /meta not ready (${res?.status ?? 'unreachable'})`);
    },
    async resolveMeasure(member) {
      try {
        return await cubeScalar({ measures: [member], limit: 1 }, member);
      } catch (e) {
        // Measure not yet compiled into Cube (sidecar sync lag) → not-yet-resolved, not a throw.
        if (isCubeSyncLag(e)) return null;
        throw e;
      }
    },
    async explore(query, securityContext) {
      try {
        const { rows } = await cubeLoad(query, { securityContext });
        return { rows };
      } catch (e) {
        if (isCubeSyncLag(e)) return { rows: [] };
        throw e;
      }
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
