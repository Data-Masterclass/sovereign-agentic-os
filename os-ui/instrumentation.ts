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

  // Boot-time SECURITY guard: refuse to serve in production with the insecure
  // dev-default session/MCP signing secret. This runs HERE (real server start) so it
  // NEVER fires during `next build` static prerender or on the edge — where a
  // module-load assertion would bake the error into a prerendered page (unclearable by
  // a runtime secret rotation). Fail-closed: exit the process so the pod crash-loops
  // and the bad deploy is loud, rather than silently signing forgeable sessions.
  try {
    const { config, assertNoDevDefaultSecretsInProd } = await import('./lib/core/config.ts');
    assertNoDevDefaultSecretsInProd(config);
  } catch (err) {
    console.error(`[os-ui] boot secret guard: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // CROSS-ORIGIN SESSION guard (telemetry only, 0.6.115): deployed apps carry the OS
  // session cookie ONLY when the OS host and the apps domain share one registrable parent
  // domain. If OS_PUBLIC_URL is a real (non-local) https host yet no such parent exists,
  // `sessionCookieDomain` returns null → a host-only cookie → deployed apps get NO session
  // → silent 401 → "builds but shows no data". Warn LOUDLY so it is diagnosable. This does
  // NOT change the cookie logic — it only surfaces the misconfiguration. Never fails boot.
  try {
    const { config } = await import('./lib/core/config.ts');
    const { sessionCookieDomain } = await import('./lib/core/session.ts');
    const osUrl = config.osPublicUrl;
    const apps = config.appsBaseDomain;
    let osHost = '';
    try {
      osHost = osUrl ? new URL(osUrl).hostname : '';
    } catch {
      /* malformed OS_PUBLIC_URL — treated as unset (local) below */
    }
    const isLocal = !osHost || osHost === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(osHost);
    if (!isLocal && sessionCookieDomain(osUrl, apps) === null) {
      console.warn(
        `[os-ui] SESSION SCOPE WARNING: OS host "${osHost}" and apps domain "${apps}" share no ` +
          'registrable parent domain, so the OS session cookie is host-only. DEPLOYED APPS WILL NOT ' +
          'CARRY THE OS SESSION (their os.whoami / os.datasets calls get 401 → no data). Put the OS and ' +
          'apps domains under one registrable domain (align OS_PUBLIC_URL + OS_APPS_DOMAIN).',
      );
    }
  } catch (err) {
    // Telemetry must never break boot — a slip here is silently downgraded to a note.
    console.warn(`[os-ui] session-scope check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Boot-time DECLARATIVE DEMO-APP seed (fire-and-forget, guarded, idempotent): stand up
  // ONE clickable AppSpec example (the Northpeak Product Catalog demo) so the OS ships a
  // live example of the declarative-app model with zero manual authoring. The seed itself
  // guards on the Northpeak dataset existing + being readable + the app not already
  // existing, so it is a silent no-op on any env that lacks that seed (fresh/CI/laptop).
  // It NEVER throws (every step is fail-soft) and is NOT awaited, so it can never delay
  // boot or fail a request. Runs BEFORE the Forgejo guard because a declarative app needs
  // no Forgejo — only the in-process app + dataset stores. The import is gated on the
  // nodejs runtime literal (already guaranteed by guard 1) so webpack DEAD-CODE-ELIMINATES
  // seed-demo's heavy server graph (apps.ts → connections/crypto) from the EDGE instrumentation
  // bundle — it must never be traced there (middleware is edge; node-only modules break it).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void import('./lib/software/appspec/seed-demo.ts')
      .then((m) => m.seedDeclarativeDemoApp())
      .catch(() => {
        /* fail-soft — the module already swallows its own errors; this guards the import */
      });
  }

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
