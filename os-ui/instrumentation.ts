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
        // RUN QUEUE (engine rebuild A4): `run_jobs` + `run_events` live in the same database and
        // their DDL is idempotent, so it runs right here next to the checkpointer's setup().
        // os-ui ENQUEUES and TAILS; `AGENTS_WORKER=worker` means the `os-ui-worker` Deployment
        // executes the jobs, `inline` (default) means this process does, straight after filing.
        const { ensureRunJobsReady } = await import('./tabs/agents/lib/build/run-jobs-server.ts');
        const jobs = await ensureRunJobsReady();
        console.info(`[os-ui] agent runs: run queue ready (${jobs}); AGENTS_WORKER=${config.agentsWorker}`);
        // A5: AGENTS_ENGINE is retired. An environment that still sets it is told, once, that it
        // does nothing — silence would let an operator believe they had pinned the old walker.
        if (process.env.AGENTS_ENGINE) {
          console.warn(
            `[os-ui] AGENTS_ENGINE=${process.env.AGENTS_ENGINE} is IGNORED and deprecated: ` +
              'there is one agent engine (LangGraph) since the engine rebuild (A5). Remove the variable.',
          );
        }
      } catch (err) {
        console.error(`[os-ui] agent runs: checkpointer setup FAILED — langgraph runs will fail until it is reachable: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  // PROJECTS IN GIT (engine rebuild B1 for data, Part D for agent systems): when
  // DATA_PROJECT_GIT=true, subscribe the ONE commit path to both stores' change events so every
  // dataset / composition / check / sync / publish / retire write regenerates the domain's dbt
  // project at the repository root, and every create / edit / grant change / build / promote /
  // rename / move / archive / delete of an agent system regenerates that domain's `agents/`
  // subtree — each committed as the acting user (name + e-mail from the user directory; a missing
  // e-mail is synthesized and said so in the commit). OFF (the default) ⇒ nothing is installed and
  // no repo is touched. Fail-soft per step: a wiring error is logged, never a boot failure.
  //
  // THE ORDER IN THIS BLOCK IS LOAD-BEARING, and it is why the two halves share one block:
  //   1. the data commit hook,
  //   2. the agents commit hook — which also calls `reserveSubtree('agents/')`,
  //   3. the DATA boot reconcile — a WHOLE-TREE commit, which keeps `agents/` only because step 2
  //      already reserved it; reconciling first would commit the subtree's DELETION,
  //   4. the AGENTS boot reconcile.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      const { config } = await import('./core/kernel/config.ts');
      if (!config.dataProjectGit) {
        console.info('[os-ui] data projects: DATA_PROJECT_GIT off — dataset and agent-system changes are not committed to git');
        return;
      }
      const { getPublicUser } = await import('./tabs/admin/lib/users.ts');
      const resolveActor = async (id: string) => {
        const u = await getPublicUser(id).catch(() => null);
        return { id, name: u?.name, email: u?.email };
      };
      // 1. data commit hook
      let dataHookInstalled = false;
      let connectionCatalog: Awaited<typeof import('./tabs/data/lib/sync-run-server.ts')>['connectionCatalogForOwner'] | undefined;
      try {
        const { installDataProjectCommitHook } = await import('./tabs/data/lib/dbt/commit.ts');
        ({ connectionCatalogForOwner: connectionCatalog } = await import('./tabs/data/lib/sync-run-server.ts'));
        installDataProjectCommitHook({ resolveActor, connectionCatalog });
        dataHookInstalled = true;
        console.info(`[os-ui] data projects: committing every dataset change to ${config.reposDir}/<domain>.git`);
      } catch (err) {
        console.error(`[os-ui] data projects: commit hook NOT installed — ${err instanceof Error ? err.message : String(err)}`);
      }
      // 2. agents commit hook — RESERVES `agents/` for the data side's whole-tree commit
      let agentsHookInstalled = false;
      try {
        const { installAgentProjectCommitHook } = await import('./tabs/agents/lib/git/commit.ts');
        installAgentProjectCommitHook({ resolveActor });
        agentsHookInstalled = true;
        console.info(`[os-ui] agent projects: committing every agent-system change to ${config.reposDir}/<domain>.git (agents/)`);
      } catch (err) {
        console.error(`[os-ui] agent projects: commit hook NOT installed — ${err instanceof Error ? err.message : String(err)}`);
      }
      // 3. DATA boot reconcile (engine rebuild B4): the hook only sees writes from NOW on, so the
      // first boot with the flag on — and any boot after a crash between a store write and its
      // commit — must commit the difference between the generated project and the repository HEAD,
      // for every domain, as the platform principal (`OS-Reason: boot-reconcile`). Commits only
      // where the tree actually moved; one unreadable domain never stops the others or the boot.
      // It runs AFTER step 2 so the reserved `agents/` subtree survives the whole-tree commit; if
      // step 2 failed, the reconcile is SKIPPED rather than allowed to delete the subtree.
      if (dataHookInstalled && agentsHookInstalled) {
        try {
          const { reconcileDataProjectsAtBoot } = await import('./tabs/data/lib/dbt/boot-reconcile.ts');
          const reconciled = await reconcileDataProjectsAtBoot({
            resolveActor: async (id) => ({ id }),
            connectionCatalog,
          });
          if (reconciled.committed.length || reconciled.failed.length) {
            console.info(
              `[os-ui] data projects: boot reconcile over ${reconciled.domains.length} domain(s) — committed ${reconciled.committed.map((c) => `${c.domain}@${c.sha.slice(0, 7)}`).join(', ') || 'nothing'}` +
                (reconciled.failed.length ? `; FAILED ${reconciled.failed.map((f) => `${f.domain} (${f.error})`).join(', ')}` : ''),
            );
          } else {
            console.info(`[os-ui] data projects: boot reconcile — ${reconciled.domains.length} domain(s) already match their repository`);
          }
        } catch (err) {
          console.error(`[os-ui] data projects: boot reconcile FAILED — ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (dataHookInstalled) {
        console.error("[os-ui] data projects: boot reconcile SKIPPED — the agents hook did not install, so 'agents/' is unreserved and a whole-tree commit would delete it");
      }
      // 4. AGENTS boot reconcile: whatever happened while the flag was off (or while a write
      // failed) is committed now, as the platform principal with `OS-Reason: boot-reconcile`, so
      // the repo is TRUE without anyone re-saving every system. Awaited inside this
      // fire-and-forget block only (never on the boot path), and it needs the store hydrated first.
      if (agentsHookInstalled) {
        try {
          const { ensureHydrated } = await import('./tabs/agents/lib/store.ts');
          await ensureHydrated();
          const { reconcileAgentProjectsAtBoot } = await import('./tabs/agents/lib/git/reconcile.ts');
          await reconcileAgentProjectsAtBoot();
        } catch (err) {
          console.error(`[os-ui] agent projects: boot reconcile FAILED — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
  }

  // TRINO ACCESS RULES (engine rebuild B3; triggers fixed in B3-review-H-2/H-3/H-4): when
  // TRINO_ACCESS_RULES=true, write the file-based access-control rules Trino chains after OPA —
  // who the dbt service user may act as, and which principals own which Iceberg schema — from the
  // OS's own directory. The chart ships a bootstrap file that bounds impersonation only; this
  // replaces it with the enumerated form, and Trino re-reads it within `security.refresh-period`
  // (no roll).
  //
  // THREE triggers, all owned by `startTrinoRulesReconciler`:
  //   boot      — once, immediately;
  //   event     — the kernel `directory-changed` event every user/domain write emits, debounced
  //               and serialised (a bulk import is ONE reconcile);
  //   periodic  — every `trinoAccessRulesIntervalMinutes`, because `helm upgrade` rewrites Helm's
  //               bootstrap value over the OS's file and emits no OS event.
  // The listener lives HERE rather than in the user store: a write path must not import a
  // reconciler, and core must not import a tab.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      try {
        const { config } = await import('./core/kernel/config.ts');
        if (!config.trinoAccessRules) return;
        const { startTrinoRulesReconciler } = await import('./core/infra/trino-rules-server.ts');
        const { rulesInputFromDirectory, OS_PRINCIPAL_PATTERN } = await import('./core/infra/trino-rules.ts');
        const { onDirectoryChange } = await import('./core/kernel/events.ts');
        const { listUsers, knownDomains } = await import('./tabs/admin/lib/users.ts');
        const { sanitizeIdent } = await import('./tabs/data/lib/store-fqn.ts');
        const handle = startTrinoRulesReconciler({
          periodMs: Math.max(1, config.trinoAccessRulesIntervalMinutes) * 60_000,
          resolve: async () => {
            const [users, domains] = await Promise.all([listUsers(), knownDomains()]);
            return rulesInputFromDirectory({
              serviceUsers: [config.trinoServiceUser],
              principalPattern: OS_PRINCIPAL_PATTERN,
              domains,
              users: users.map((u) => ({ id: u.id, domains: u.domains, disabled: u.disabled })),
              sanitize: sanitizeIdent,
            });
          },
        });
        onDirectoryChange((reason) => handle.trigger(reason));
        console.info(
          `[os-ui] trino access rules: reconciling at boot, on every directory write, and every ${config.trinoAccessRulesIntervalMinutes} min`,
        );
      } catch (err) {
        console.warn(`[os-ui] trino access rules: reconcile skipped — ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }
}
