/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Next.js instrumentation hook (Next 15+, stable). `register()` is called
 * ONCE by the Node.js runtime at os-ui startup — before any request is served.
 *
 * We use it for a fire-and-forget boot-time reconcile: any governed datasets
 * missing from the analytics Forgejo repo are diff-written here. Because
 * `writeAnalyticsFiles` is idempotent (sha-based diff-write, no commit when
 * content is unchanged), this is a safe, cheap no-op on a warm git mirror.
 *
 * Guard layers:
 *   1. `NEXT_RUNTIME === 'nodejs'` — skip on the Edge runtime (no Node APIs).
 *   2. `FORGEJO_URL` env var — skip when Forgejo is not configured (local dev
 *      without the cluster, CI, etc.). The analytics repo is only reachable when
 *      this is set to a real in-cluster or remote URL.
 *   3. `reconcileAnalyticsRepo`'s own module-level `_reconciled` flag — runs
 *      at most ONCE per os-ui process (no-op on HMR re-register).
 *   4. Fire-and-forget — `register()` itself does NOT await the reconcile, so
 *      Forgejo latency or a transient down-state NEVER delays boot or fails a
 *      request. If Forgejo is down, the next os-ui restart will retry.
 *
 * For an immediate reconcile (e.g. after seeding many datasets), an operator
 * can POST /api/admin/analytics/backfill — that endpoint awaits the result and
 * reports exactly which files were written.
 */
export async function register(): Promise<void> {
  // Guard 1: Node.js runtime only (edge has no Buffer / fetch-credential access).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Guard 2: Forgejo must be explicitly configured. When FORGEJO_URL is unset
  // the app falls back to the in-cluster default — but on a laptop without the
  // cluster that default is unreachable and we should not spin up a fire-and-
  // forget that will log connection errors on every dev restart.
  if (!process.env['FORGEJO_URL']) return;

  // Dynamic imports: keeps this instrumentation module edge-clean at import time.
  // All three modules are server-only; we reach them only on the nodejs runtime
  // (guard 1 above) so the `server-only` sentinel in live-clients.ts is satisfied.
  const [{ realForgejo }, { listGovernedDatasets, ensureHydrated }, { reconcileAnalyticsRepo }] =
    await Promise.all([
      import('./lib/agents/build/live-clients.ts'),
      import('./lib/data/store.ts'),
      import('./lib/data/analytics-repo.ts'),
    ]);

  // Best-effort hydrate: the dataset store may not yet have loaded its durable
  // mirror (OpenSearch). Hydration failure is non-fatal — listGovernedDatasets
  // still returns any in-process seed data (the pre-existing 6 runtime cubes).
  await ensureHydrated().catch(() => {});

  // Guard 3 + 4: reconcileAnalyticsRepo is once-guarded and fire-and-forget.
  reconcileAnalyticsRepo(realForgejo(), listGovernedDatasets());
}
