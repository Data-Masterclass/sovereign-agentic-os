/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import yaml from 'js-yaml';
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

/** The measure MEMBERS (`View.measure`) a generated schema declares — what reload
 *  awaits delivery of. Tolerant of a malformed schema (empty list, never a throw). */
export function measureMembersFromSchema(schema: string, view: string): string[] {
  try {
    const doc = yaml.load(schema) as { cubes?: { measures?: { name?: unknown }[] }[] } | null;
    const out: string[] = [];
    for (const c of doc?.cubes ?? []) {
      for (const m of c?.measures ?? []) {
        if (typeof m?.name === 'string' && m.name) out.push(`${view}.${m.name}`);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Bounded await-delivery: poll `probe` until it reports delivered, up to `budgetMs`.
 * Returns 'delivered' | 'pending' HONESTLY — never fabricates readiness, never throws
 * on a timeout (a probe error still propagates). Injectable sleep/now so tests run
 * without real waiting.
 */
export async function awaitDelivery(
  probe: () => Promise<boolean>,
  opts: { budgetMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<'delivered' | 'pending'> {
  const budgetMs = opts.budgetMs ?? 12000; // ~2 sidecar poll intervals
  const intervalMs = opts.intervalMs ?? 2000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + budgetMs;
  for (;;) {
    if (await probe()) return 'delivered';
    if (now() >= deadline) return 'pending';
    await sleep(intervalMs);
  }
}

export function realMetricCube(): MetricCubeClient {
  async function resolveMeasure(member: string): Promise<number | null> {
    try {
      return await cubeScalar({ measures: [member], limit: 1 }, member);
    } catch (e) {
      // Measure not yet compiled into Cube (sidecar sync lag) → not-yet-resolved, not a throw.
      if (isCubeSyncLag(e)) return null;
      throw e;
    }
  }
  return {
    async reload(view, schema) {
      // BOUNDED AWAIT-DELIVERY (replaces the old /meta liveness ping, which proved Cube
      // was up but said nothing about THIS schema). Cube's schema comes from the
      // model-sync sidecar (polls os-ui's GET /api/cube/models every few seconds and
      // writes the .cube.yml files; schemaVersion() lazily recompiles on the next
      // query) — so we poll until every measure the schema declares actually RESOLVES
      // (the same resolveMeasure probe verify uses; the query also triggers the lazy
      // recompile), up to ~12 s = 2 sidecar intervals. Delivered → done; still pending
      // after the budget → return quietly and let verify report the non-resolution
      // honestly (the build shows "syncing", not a false ✓). A genuine Cube error
      // (unreachable / 5xx) still throws ⇒ ✗.
      const unresolved = new Set(measureMembersFromSchema(schema, view));
      await awaitDelivery(async () => {
        for (const member of [...unresolved]) {
          if ((await resolveMeasure(member)) !== null) unresolved.delete(member);
        }
        return unresolved.size === 0;
      });
    },
    resolveMeasure,
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

/** Is the metric READ path's irreplaceable dependency reachable? Since the
 *  metrics→Trino migration (Phase 1) every metric read serves as governed Trino SQL —
 *  so the probe targets TRINO, not Cube: a down Cube must no longer report metrics as
 *  unavailable (it only serves dashboards now), and a down Trino must (honesty gate). */
export async function liveMetricsReachable(): Promise<boolean> {
  const res = await withTimeout(`http://${config.trinoHost}:${config.trinoPort}/v1/info`, 2500);
  return Boolean(res && res.ok);
}
