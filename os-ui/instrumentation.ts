/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Next.js instrumentation hook (Next 15+, stable). `register()` is called
 * ONCE by the Node.js runtime at os-ui startup — before any request is served.
 *
 * We use it for boot-time guards + fire-and-forget seeds:
 *   1. `NEXT_RUNTIME === 'nodejs'` — skip on the Edge runtime (no Node APIs).
 *   2. A FAIL-CLOSED secret guard (production must never sign sessions with the
 *      shipped dev placeholder) plus telemetry-only config warnings.
 *   3. An idempotent, never-awaited declarative demo-app seed.
 *
 * Nothing here may throw or delay boot: every step is fail-soft.
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
    const { config, assertNoDevDefaultSecretsInProd } = await import('./core/kernel/config.ts');
    assertNoDevDefaultSecretsInProd(config);
  } catch (err) {
    console.error(`[os-ui] boot secret guard: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // TAB GATING warnings (telemetry only): surface typo'd keys and omissions that would
  // 404 the landing page / admin UI. Never fails boot.
  try {
    const { config } = await import('./core/kernel/config.ts');
    const { enabledTabsWarnings } = await import('./core/kernel/tabs.ts');
    for (const w of enabledTabsWarnings(config.enabledTabs)) console.warn(`[os-ui] OS_ENABLED_TABS: ${w}`);
  } catch {
    /* telemetry must never break boot */
  }

  // CROSS-ORIGIN SESSION guard (telemetry only, 0.6.115): deployed apps carry the OS
  // session cookie ONLY when the OS host and the apps domain share one registrable parent
  // domain. If OS_PUBLIC_URL is a real (non-local) https host yet no such parent exists,
  // `sessionCookieDomain` returns null → a host-only cookie → deployed apps get NO session
  // → silent 401 → "builds but shows no data". Warn LOUDLY so it is diagnosable. This does
  // NOT change the cookie logic — it only surfaces the misconfiguration. Never fails boot.
  try {
    const { config } = await import('./core/kernel/config.ts');
    const { sessionCookieDomain } = await import('./core/kernel/session.ts');
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
  // boot or fail a request. The import is gated on the
  // nodejs runtime literal (already guaranteed by guard 1) so webpack DEAD-CODE-ELIMINATES
  // seed-demo's heavy server graph (apps.ts → connections/crypto) from the EDGE instrumentation
  // bundle — it must never be traced there (middleware is edge; node-only modules break it).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void import('./tabs/software/lib/appspec/seed-demo.ts')
      .then((m) => m.seedDeclarativeDemoApp())
      .catch(() => {
        /* fail-soft — the module already swallows its own errors; this guards the import */
      });
  }

  // APPROVAL → RESUME hook (engine rebuild A2): the Agents tab registers its graph-resume with the
  // Governance queue's `onDecided` so approving a parked run's write (inbox route or MCP
  // `decide_approval`) continues the run as its runner. A registration, never a core→tab import.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { registerResumeHook } = await import('./tabs/agents/lib/engine/resume-boot.ts');
      registerResumeHook();
    } catch (err) {
      console.error(`[os-ui] agent runs: approval-resume hook NOT registered — parked runs will not resume on decision: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // AGENT-RUN CHECKPOINTER init (engine rebuild A1): when AGENT_RUNS_DATABASE_URL is set, run
  // `PostgresSaver.setup()` once at boot (idempotent CREATE TABLE IF NOT EXISTS + migrations) so
  // the first run never races the schema. Not awaited (boot must not wait on Postgres); a
  // failure is logged LOUDLY and the first run retries it — it never falls back to memory
  // silently. Unset → the memory checkpointer, logged once so an operator can see it.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      try {
        const { config } = await import('./core/kernel/config.ts');
        const { ensureCheckpointerReady } = await import('./tabs/agents/lib/engine/checkpointer.ts');
        const kind = await ensureCheckpointerReady(config.agentRunsDatabaseUrl);
        if (kind === 'memory') console.warn('[os-ui] agent runs: AGENT_RUNS_DATABASE_URL unset — LangGraph checkpoints are IN MEMORY (not durable across restarts)');
        else console.info('[os-ui] agent runs: Postgres checkpointer ready (agent_runs)');
      } catch (err) {
        console.error(`[os-ui] agent runs: checkpointer setup FAILED — langgraph runs will fail until it is reachable: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }
}
