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

  // SUBTREE RESERVATION, FIRST (Part D review H-2). `agents/` belongs to the Agents tab, and the
  // data side's generator writes the WHOLE tree: without the reservation ITS first commit deletes
  // the subtree. The ordered boot block below installs the agents hook (which also reserves)
  // before the data reconcile runs, and the data reconcile is skipped if that hook failed — but
  // both of those are ORDERING arguments, and an ordering argument is one careless edit away from
  // being wrong. The reservation itself is idempotent, costs nothing and depends on nothing, so it
  // is taken HERE, before any other boot step, and the ordering becomes a second line of defence
  // rather than the only one. The literal must stay equal to `AGENTS_PREFIX`
  // (`tabs/agents/lib/git/generate.ts`); `tabs/agents/lib/git/commit.test.ts` asserts it does.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { config } = await import('./core/kernel/config.ts');
      if (config.dataProjectGit) {
        const { reserveSubtree } = await import('./core/infra/git-store.ts');
        reserveSubtree('agents/');
        // Night 2 / stream D: the Dashboards tab owns `dashboards/` in the same domain repo, so it
        // needs the same reservation for the same reason — the dbt generator writes the WHOLE tree
        // and its next commit would otherwise delete the subtree. Reserved HERE rather than only in
        // the commit hook because the data boot reconcile (step 3 below) runs a whole-tree commit.
        // The literal must stay equal to `DASHBOARDS_PREFIX`
        // (`tabs/dashboards/lib/git/generate.ts`); `tabs/dashboards/lib/git/boot.test.ts` asserts it.
        reserveSubtree('dashboards/');
        // Night 2 / stream S, review H-3: `apps/` is reserved HERE for exactly the same reason, and
        // for the same second-line-of-defence argument. It was previously registered in a floating
        // IIFE at the END of `register()`, which meant the data boot reconcile below could run
        // FIRST and delete every app's source tree — the D-1 defect repeated. The literal must stay
        // equal to `APPS_PREFIX` (`tabs/software/lib/git-commit.ts`); `git-commit.test.ts` asserts
        // it does, and `tabs/software/lib/apps-reservation.test.ts` asserts the ORDER, not merely
        // the existence.
        reserveSubtree('apps/');
        // WP-50: `connections/` holds each warehouse connection's Trino catalog file; the literal
        // must stay equal to `CONNECTIONS_PREFIX` (`tabs/connections/lib/git/generate.ts`).
        reserveSubtree('connections/');
        // WP-50: `knowledge/` is the domain's OKF bundle; the literal must stay equal to
        // `KNOWLEDGE_PREFIX` (`tabs/knowledge/lib/git/bundle.ts`).
        reserveSubtree('knowledge/');
      }
    } catch (err) {
      console.error(`[os-ui] projects: could NOT reserve the 'agents/' + 'dashboards/' + 'apps/' subtrees — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // LIFECYCLE (night 2, stream V): reserve the pin file's own subtree and register the per-kind
  // adapters. The kernel must never import a tab, so each tab's adapter registers itself HERE —
  // the one place in os-ui that is allowed to know both halves. Registration is pure (a Map
  // write), never awaited on a request path, and a kind with no adapter is an honest refusal
  // from go_live rather than a silent success, so a failure here cannot corrupt anything.
  // EDGE-COMPILE GUARD (PR #48 CI `build`): `middleware.ts` makes Next compile this file for the
  // edge runtime too. webpack skips the dependencies inside an `if (process.env.NEXT_RUNTIME ===
  // 'nodejs') { ... }` BLOCK (constant-folded per compiler), but NOT code that merely follows the
  // early `return` above — so a dynamic import outside such a block is bundled for edge and fails
  // on `node:`/`crypto`/`http`. Every `await import(` in this file must sit inside one of these
  // blocks; `core/kernel/instrumentation-edge-guard.test.ts` asserts it.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
  try {
    const { reserveLifecycleSubtree } = await import('./core/infra/lifecycle-pins.ts');
    reserveLifecycleSubtree();
    const { registerLifecycleAdapter } = await import('./core/kernel/lifecycle-adapters.ts');
    const { dashboardLifecycleAdapter } = await import('./tabs/dashboards/lib/lifecycle-adapter.ts');
    const { agentLifecycleAdapter } = await import('./tabs/agents/lib/lifecycle-adapter.ts');
    registerLifecycleAdapter(dashboardLifecycleAdapter);
    registerLifecycleAdapter(agentLifecycleAdapter);
    const { datasetLifecycleAdapter } = await import('./tabs/data/lib/lifecycle-adapter.ts');
    const { metricLifecycleAdapter } = await import('./tabs/metrics/lib/lifecycle-adapter.ts');
    const { knowledgeLifecycleAdapter } = await import('./tabs/knowledge/lib/lifecycle-adapter.ts');
    const { connectionLifecycleAdapter } = await import('./tabs/connections/lib/lifecycle-adapter.ts');
    const { appLifecycleAdapter } = await import('./tabs/software/lib/lifecycle-adapter.ts');
    registerLifecycleAdapter(datasetLifecycleAdapter);
    // WP-51: a metric's semantic YAML is written by the data project's writer, so the metric's
    // live tag names the commit that writer makes. Wired here: a tab may not import another tab.
    const { commitDataDefinition } = await import('./tabs/data/lib/dbt/commit.ts');
    registerLifecycleAdapter({
      ...metricLifecycleAdapter,
      commitDefinition: (actor, obj, deps) => commitDataDefinition(obj.domain, actor, { object: obj.name, objectId: `metric:${obj.id}` }, deps),
    });
    registerLifecycleAdapter(knowledgeLifecycleAdapter);
    registerLifecycleAdapter(connectionLifecycleAdapter);
    registerLifecycleAdapter(appLifecycleAdapter);
    // NIGHT-2 MERGE (V-13, D x V): D's `tabs/dashboards/lib/lifecycle-port.ts` is the seam the
    // Dashboards tab reads a pin through, so that the tab can record "which version is live" in
    // `dashboard.yaml` without importing a module that did not exist on its branch. This is the
    // line that installs V's real reader into it. ASYNC (D's H-5): V's pins live in a durable
    // mirror, so a synchronous port could only ever have been wired to a stale copy. `?? null`
    // because V returns `undefined` for "no pin" and the port's contract is `null`.
    const { setLifecycleReader } = await import('./tabs/dashboards/lib/lifecycle-port.ts');
    const { livePin: livePinOf } = await import('./core/infra/lifecycle-pins.ts');
    setLifecycleReader(async (kind, id) => (await livePinOf(kind, id)) ?? null);
  } catch (err) {
    console.error(`[os-ui] lifecycle: adapters NOT registered — go_live will refuse, naming the kind. ${err instanceof Error ? err.message : String(err)}`);
  }
  }

  // Boot-time SECURITY guard: refuse to serve in production with the insecure
  // dev-default session/MCP signing secret. This runs HERE (real server start) so it
  // NEVER fires during `next build` static prerender or on the edge — where a
  // module-load assertion would bake the error into a prerendered page (unclearable by
  // a runtime secret rotation). Fail-closed: exit the process so the pod crash-loops
  // and the bad deploy is loud, rather than silently signing forgeable sessions.
  // WP-53e: with AGENT_GRAPH_MODULE on, the generator's host inputs (exact versions + lockfile) are
  // read once at boot, in THIS bundle, so a server that cannot generate a graph.mjs says so here —
  // not on the first agent-definition commit. `scripts/check-built-module-inputs.mjs` boots the
  // BUILT server and requires the "ok" line. Before the secret guard: it is read-only, and a boot the
  // guard stops still reports whether this bundle can generate modules.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { config } = await import('./core/kernel/config.ts');
      if (config.agentGraphModule) {
        const { hostModuleInputs } = await import('./tabs/agents/lib/module/versions.ts');
        const { hostNodeModules } = await import('./core/adapters/agent-module/load.ts');
        const { versions } = hostModuleInputs();
        // An inline module run links its cache to these node_modules — the same known path.
        const nodeModules = hostNodeModules();
        console.log(`[os-ui] agent modules: host inputs ok — @langchain/langgraph ${versions['@langchain/langgraph']}, lockfile ${config.agentModuleHostLockfile}, node_modules ${nodeModules}`);
      }
    } catch (err) {
      console.error(`[os-ui] agent modules: host inputs NOT readable — no graph.mjs can be generated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (process.env.NEXT_RUNTIME === 'nodejs') {
  try {
    const { config, assertNoDevDefaultSecretsInProd, assertLangfuseCredentialsInProd } = await import('./core/kernel/config.ts');
    assertNoDevDefaultSecretsInProd(config);
    // No built-in Langfuse credentials in production: a missing key or console login stops the boot.
    assertLangfuseCredentialsInProd(config);
    // Every secret os-ui depends on: missing, or equal to a public development default, refuses
    // the boot (compared by SHA-256 in-process; only variable names are logged).
    const { assertProductionSecrets } = await import('./core/kernel/secret-guard.ts');
    assertProductionSecrets('os-ui');
  } catch (err) {
    console.error(`[os-ui] boot secret guard: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  }

  // OPA STATE RECONCILER (interim until WP-11 bundles): OPA holds REST-pushed data in memory only,
  // so an OPA restart loses every grant, domain principal, governed table, approval hold and
  // guardrail policy os-ui pushed — and every non-seeded domain is refused. Each tab's restore
  // SOURCE is registered here via `opa-state-sources.ts` (the kernel never imports a tab) and `startOpaReconciler` restores
  // them at boot, every five minutes, and as soon as `GET /health` + the canary show OPA lost its
  // state. Web process only (process-role). A failure is logged and shown in Monitoring as
  // "Policy state not restored"; it never stops the boot.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { registerOpaStateSources } = await import('./opa-state-sources.ts');
      registerOpaStateSources();
      // Delete domain: the ordered component list both doors read (domain-delete-sources.ts).
      const { registerDomainDeleteSources } = await import('./domain-delete-sources.ts');
      registerDomainDeleteSources();
      // Monitoring panels: the Agents and Data tabs' scoped readers (monitoring-sources.ts).
      const { registerMonitoringPanelSources } = await import('./monitoring-sources.ts');
      registerMonitoringPanelSources();
      // Connected-drive owner alerts (sync failed · behind · needs reconnect): a timer in os-ui, so a lag
      // alert still fires when Dagster (which runs the schedule) is down.
      const { startDriveHealthWatch } = await import('./drive-health-watch.ts');
      startDriveHealthWatch();
      const { startOpaReconciler } = await import('./core/policy/opa-reconcile.ts');
      startOpaReconciler();
      // WP-11 (OS_OPA_DATA_BUNDLE=1): the same sources compile the os-data bundle OPA downloads
      // and persists itself; the reconciler above then pushes only the unbundled guardrails.
      const { config: cfg } = await import('./core/kernel/config.ts');
      const { isRunWorkerProcess } = await import('./core/kernel/process-role.ts');
      if (cfg.opaDataBundle && !isRunWorkerProcess()) {
        const { startOsDataBundle } = await import('./core/policy/bundle.ts');
        startOsDataBundle();
      }
      // WP-16 (10 F10): dbt's parse verdict per commit, from repo-sync, into commit_checks.
      if (cfg.dagsterRepoStatusUrl && cfg.governanceDatabaseUrl && !isRunWorkerProcess()) {
        const { startDbtParseVerdictCopy } = await import('./core/adapters/dagster/commit-checks.ts');
        const { governanceRuntimePool } = await import('./core/adapters/postgres/pool.ts');
        startDbtParseVerdictCopy(governanceRuntimePool);
      }
      // Ownership rule (dbt tests run in Dagster's scheduled runs): read the check executions back on a
      // timer so an owner hears about a failing run without opening a page. Reads only.
      if (cfg.dataProjectGit && cfg.dagsterUrl && !isRunWorkerProcess()) {
        const { scheduleEvery } = await import('./core/reconcile/runtime.ts');
        scheduleEvery('dq-readback', 5 * 60_000, async () => {
          const { listAllDatasets } = await import('./tabs/data/lib/store.ts');
          const { readbackAllDq } = await import('./tabs/data/lib/dq-status-server.ts');
          await readbackAllDq(listAllDatasets().filter((d) => d.domain).map((d) => ({ id: d.id, domain: d.domain })));
        });
      }
      // WP-15: grants whose Dagster run finished stop letting Dagster act as their owner.
      if (cfg.dagsterRunGrants && !isRunWorkerProcess()) {
        const { startRunGrantFinisher } = await import('./core/policy/run-grant-finisher.ts');
        startRunGrantFinisher();
      }
    } catch (err) {
      console.error(`[os-ui] opa state: reconciler NOT started — POLICY STATE WILL NOT BE RESTORED after an OPA restart: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // TAB GATING warnings (telemetry only): surface typo'd keys and omissions that would
  // 404 the landing page / admin UI. Never fails boot.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
  try {
    const { config } = await import('./core/kernel/config.ts');
    const { enabledTabsWarnings } = await import('./core/kernel/tabs.ts');
    for (const w of enabledTabsWarnings(config.enabledTabs)) console.warn(`[os-ui] OS_ENABLED_TABS: ${w}`);
  } catch {
    /* telemetry must never break boot */
  }
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

  // APPROVED APP WRITE runner: approving a write a Software app's action was held on must run it
  // (or fail the approval with the reason). The Software tab owns how an app action runs and the
  // Connections tab owns domain adoptions; they are composed here and registered into core's port,
  // so `applyEffect` stays free of both tabs. Adoptions are read fresh per approval.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { registerAppWriteApplier } = await import('./core/policy/app-write-port.ts');
      const { applyApprovedAppWrite } = await import('./tabs/software/lib/app-write-approval.ts');
      const { allActiveAdoptions, adoptionCovers } = await import('./tabs/connections/lib/action-adoptions.ts');
      registerAppWriteApplier(async (req) => {
        const adoptions = await allActiveAdoptions().catch(() => []);
        return applyApprovedAppWrite(req, {
          adoption: { adopted: (exposureId, domain, action) => adoptionCovers(adoptions, exposureId, domain, action) },
        });
      });
    } catch (err) {
      console.error(`[os-ui] approved app writes: runner NOT registered — approving one will report that it did not run: ${err instanceof Error ? err.message : String(err)}`);
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

  // KEY MIGRATION, MAKE-BEFORE-BREAK. Per-system model keys used to be `sk-os-<systemId>`
  // (guessable) or missing. At boot every existing system that has no usable stored key is moved
  // onto a random, budgeted key through the Build's own key step: the new key is stored and in use
  // BEFORE the old one is deleted, so no system (and no schedule) stops. Until the pass completes,
  // a worker run with no stored key waits for it. Then the sweep removes what nothing can be
  // running on (derivable keys of deleted systems, the unbudgeted reconcile keys). Retried while
  // the gateway or the registry is not up yet. Web process only: it needs the gateway's admin API.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      try {
        const { scheduleBootKeyMigration, migrateThenSweepLive } = await import('./tabs/agents/lib/build/system-key-migration.ts');
        scheduleBootKeyMigration(migrateThenSweepLive);
      } catch (err) {
        console.error(`[os-ui] key migration: could not be scheduled: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  // CONTINUOUS KEY RECONCILE. The platform team edits keys in LiteLLM directly, so each agent
  // system's key is compared with its definition on a timer (default every 5 minutes) and a
  // difference is REPORTED — Admin → Gateway and Monitoring → Agents — not overwritten, unless an
  // admin switched auto-correct on for that system (`osUI.agentSystemKey.reconcile`). The first
  // pass is one interval after boot, so the key migration above has finished first. Web process only.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      try {
        const { scheduleKeyReconcile, reconcileKeysLive, installKeySyncOnSave } = await import('./tabs/agents/lib/build/key-reconcile.ts');
        scheduleKeyReconcile(reconcileKeysLive);
        // ON SAVE: a saved definition re-stamps its key's OS-derived fields (allowed tools, models), off the request.
        installKeySyncOnSave();
        // BEFORE EVERY RUN: the run queue asks through the kernel seam; only this (web) process can answer it.
        const { registerPreRunKeySync } = await import('./core/kernel/key-sync-port.ts');
        const { syncDerivedKeyFieldsLive } = await import('./tabs/agents/lib/build/key-reconcile.ts');
        registerPreRunKeySync((systemId, actor) => syncDerivedKeyFieldsLive(systemId, 'pre-run-sync', actor));
      } catch (err) {
        console.error(`[os-ui] key reconcile: could not be scheduled: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  // ROLE NAMES ON EXISTING KEYS. A key minted before the role names lacks them, so a call on sovereign-strong
  // would be refused. Once at boot the OS ADDS the three names to the shared agent key and to every agent-system
  // key it owns (never removes, never changes a value, never touches another key; audited; idempotent).
  // AGENT_KEY_ROLE_MIGRATION=apply (default) | dry-run (log the plan only) | off. Web process only.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      try {
        const mode = (process.env.AGENT_KEY_ROLE_MIGRATION ?? 'apply').trim().toLowerCase();
        const { liteLlmConfigured } = await import('./core/infra/litellm-admin.ts');
        if (mode === 'off' || !liteLlmConfigured()) return;
        const { migrateRoleKeysLive } = await import('./tabs/agents/lib/build/role-key-migration-live.ts');
        // Idempotent, so it is simply repeated while a pass could not complete (gateway or registry not ready at boot).
        for (const waitMs of [0, 60_000, 300_000]) {
          if (waitMs) await new Promise((res) => setTimeout(res, waitMs));
          const r = await migrateRoleKeysLive({ dryRun: mode === 'dry-run' });
          console.info(`[os-ui] role-key migration (${mode}): ${r.changed.length} changed, ${r.skipped.length} left alone, ${r.errors.length} error(s)${r.errors.length ? `: ${r.errors.join('; ')}` : ''}`);
          if (r.ok) break;
        }
      } catch (err) {
        console.error(`[os-ui] role-key migration: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  // MODEL ROLE MAPPING. The OS owns which catalog model each of the three roles (sovereign-strong, -worker,
  // -embedding) means (`os/models.yml` in the platform repo) and enforces it at LiteLLM's
  // `router_settings.model_group_alias`: once at boot, then every MODEL_ROLE_RECONCILE_INTERVAL_SECONDS
  // (default 300; 0 = off). A foreign edit of the alias is put back and reported; a role whose model left the
  // catalog is a warning, never a silent fallback. Web process only (it needs the gateway's master key).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      try {
        const [{ scheduleRoleReconcile }, { liveRoleIo }, { liteLlmConfigured }, { seedRoleMappingLive }] = await Promise.all([
          import('./core/models/role-reconcile.ts'),
          import('./core/models/role-live.ts'),
          import('./core/infra/litellm-admin.ts'),
          import('./tabs/admin/lib/role-seed-live.ts'),
        ]);
        const raw = (process.env.MODEL_ROLE_RECONCILE_INTERVAL_SECONDS ?? '').trim();
        const seconds = raw === '' ? 300 : Math.max(0, Math.floor(Number(raw)) || 0);
        // First boot: `os/models.yml` is created from the old admin override or the chart seed (never overwritten).
        if (liteLlmConfigured()) scheduleRoleReconcile(liveRoleIo, seconds, () => seedRoleMappingLive({ by: 'system:os-ui' }));
      } catch (err) {
        console.error(`[os-ui] model role reconcile: could not be scheduled: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  // WORKFLOW GRANTS: agent systems saved before workflows and knowledge notes were split name their
  // workflows under `grants.knowledge` and use the `*_knowledge` tool names. The read path already
  // upgrades them in memory, so nothing stops; this pass rewrites the stored `system.yaml` to agree
  // (OS_WORKFLOW_GRANT_MIGRATION = apply (default) | dry-run | off). Idempotent; web process only.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      try {
        const { scheduleBootWorkflowGrantMigration } = await import('./tabs/agents/lib/workflow-grant-migration.ts');
        scheduleBootWorkflowGrantMigration();
      } catch (err) {
        console.error(`[os-ui] workflow grant migration: could not be scheduled: ${err instanceof Error ? err.message : String(err)}`);
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
  // (`reserveSubtree('agents/')` has ALREADY run, at the very top of `register()` — review H-2 —
  // so the ordering below is now defence in depth rather than the only thing standing between a
  // whole-tree commit and the agents subtree.)
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
      // 0. REPOSITORY LAYOUT MIGRATION (component design 12), behind `OS_REPO_LAYOUT_MIGRATION`
      // (chart `osUI.dataProjectGit.layout.migration`, default off). It runs BEFORE every hook and
      // reconcile so they all regenerate at the v2 paths; `dry-run` logs the plan and writes
      // nothing. Fail-soft per repo: one repo that cannot migrate stays v1 and is named.
      try {
        const { migrationMode, migrationDomains, migrateAllRepos } = await import('./core/infra/repo-layout-migrate.ts');
        const mode = migrationMode();
        if (mode !== 'off') {
          const domains = migrationDomains();
          console.info(`[os-ui] repo layout ${mode}: ${domains ? `domains ${domains.join(', ')} only` : 'every domain'}`);
          for (const r of await migrateAllRepos({ dryRun: mode === 'dry-run', domains })) {
            if ('error' in r) console.error(`[os-ui] repo layout ${mode}: ${r.domain} NOT migrated — ${r.error}`);
            else if (r.alreadyMigrated) console.info(`[os-ui] repo layout ${mode}: ${r.domain} already v2`);
            else console.info(`[os-ui] repo layout ${mode}: ${r.domain} ${r.from} -> ${r.to}: ${r.moves.length} move(s), ${r.personal.length} personal lane(s) -> ${r.personal.map((x) => x.userRepo).join(', ') || 'none'}, ${r.readmes.length} README(s)${r.sha ? ` — commit ${r.sha.slice(0, 12)}` : ''}`);
          }
        }
      } catch (err) {
        console.error(`[os-ui] repo layout migration FAILED to run — ${err instanceof Error ? err.message : String(err)}`);
      }
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
      // 2a. CONNECTIONS (WP-50): commits run from the store's own writers; here they learn the
      // actor's display name and e-mail from the admin directory.
      try {
        const { setConnectionActorResolver } = await import('./tabs/connections/lib/git/commit.ts');
        setConnectionActorResolver(resolveActor);
      } catch (err) {
        console.error(`[os-ui] connections: actor resolver NOT installed — commits carry the id only: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 2a-k. KNOWLEDGE (WP-50): commits run from the store's own writers; here they learn the
      // actor's name and e-mail, and the store is rebuilt FROM each domain's committed bundle
      // (git is the source of truth; the domain manual had no other persistence).
      try {
        const { setKnowledgeActorResolver } = await import('./tabs/knowledge/lib/git/commit.ts');
        setKnowledgeActorResolver(resolveActor);
        const { listAllRepos } = await import('./core/infra/git-store.ts');
        const domains = (await listAllRepos()).filter((r) => r.kind === 'domain' && r.domain).map((r) => r.domain as string);
        const { reconcileKnowledgeFromGit } = await import('./tabs/knowledge/lib/store.ts');
        const report = await reconcileKnowledgeFromGit(domains);
        console.info(`[os-ui] knowledge: read back ${report.length} domain bundle(s) from git`);
      } catch (err) {
        console.error(`[os-ui] knowledge: git read-back NOT run — ${err instanceof Error ? err.message : String(err)}`);
      }
      // 2b. DASHBOARDS commit hook (night 2 / stream D) — every dashboard write becomes a commit
      // under `dashboards/**`. Installed after the agents hook and BEFORE the data boot reconcile,
      // for the same ordering reason: the reconcile is a whole-tree commit and the subtree must
      // already be reserved (it is, at the top of `register()`, and again by this hook).
      let dashboardsHookInstalled = false;
      try {
        const { installDashboardCommitHook } = await import('./tabs/dashboards/lib/git/commit.ts');
        installDashboardCommitHook({ resolveActor });
        dashboardsHookInstalled = true;
        console.info(`[os-ui] dashboard projects: committing every dashboard change to ${config.reposDir}/<domain>.git (dashboards/)`);
      } catch (err) {
        console.error(`[os-ui] dashboard projects: commit hook NOT installed — ${err instanceof Error ? err.message : String(err)}`);
      }
      // 3. DATA boot reconcile (engine rebuild B4): the hook only sees writes from NOW on, so the
      // first boot with the flag on — and any boot after a crash between a store write and its
      // commit — must commit the difference between the generated project and the repository HEAD,
      // for every domain, as the platform principal (`OS-Reason: boot-reconcile`). Commits only
      // where the tree actually moved; one unreadable domain never stops the others or the boot.
      // It runs AFTER step 2 so the reserved `agents/` subtree survives the whole-tree commit; if
      // step 2 failed, the reconcile is SKIPPED rather than allowed to delete the subtree. Review
      // H-3: the same condition now covers `apps/` — a whole-tree reconcile with `apps/`
      // unreserved would delete every app's source tree, so the reconcile is skipped unless the
      // reservation is demonstrably in place (checked against the registry, not assumed).
      const reserved = await (async () => {
        try {
          const { reservedSubtrees } = await import('./core/infra/git-store.ts');
          return reservedSubtrees();
        } catch {
          return [] as string[];
        }
      })();
      const appsReserved = reserved.includes('apps/');
      if (!appsReserved) {
        console.error("[os-ui] software: 'apps/' is NOT reserved — the data boot reconcile is SKIPPED, because a whole-tree commit would delete every app's source tree");
      }
      if (dataHookInstalled && agentsHookInstalled && appsReserved) {
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
      // 5. DASHBOARDS boot reconcile (night 2 / stream D, review H-4): same contract as 3 and 4 —
      // whatever changed while the flag was off, or while a write failed between the store and the
      // commit, is committed now as the platform principal with `OS-Reason: boot-reconcile`. It
      // runs LAST because it is the newest and least load-bearing of the three, and it refuses to
      // run at all unless the dashboard registry says `'hydrated'`: an empty store whose mirror was
      // unreachable is indistinguishable from a tenant with no dashboards, and committing the
      // former would delete every dashboard directory in every domain. The store must be hydrated
      // first, exactly as the agents reconcile requires.
      if (dashboardsHookInstalled) {
        try {
          const { ensureHydrated } = await import('./tabs/dashboards/lib/store.ts');
          await ensureHydrated();
          const { reconcileDashboardsAtBoot } = await import('./tabs/dashboards/lib/git/reconcile.ts');
          await reconcileDashboardsAtBoot();
        } catch (err) {
          console.error(`[os-ui] dashboard projects: boot reconcile FAILED — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    })();
  }

  // LIFECYCLE MIGRATION (stream V, review H-2)
  //
  // NIGHT-2 MERGE — this block MOVED. It used to sit beside the adapter registrations near the top
  // of `register()`, which put it BEFORE the data / agents / dashboards boot reconciles. The
  // migration pins every existing object to what is live NOW, so starting it first could pin a
  // head that the dashboards reconcile was about to move — a dashboard pinned to a commit that
  // does not contain its file. It therefore runs AFTER all three reconciles, which is the boot
  // order the night-2 merge brief mandates: reservations -> git hooks/installers -> data reconcile
  // -> agents reconcile -> dashboards reconcile -> lifecycle-migrate -> the E/G appends below.
  // It is still fire-and-forget and still self-gating on the pin index having really been READ: every object that already exists becomes Live, ONCE, so
  // the day this ships looks exactly like the day before — every dashboard, every schedule.
  // (`not-hydrated` defers to the next boot), because an empty index from a dead mirror is
  // indistinguishable from a tenant with nothing live. Never awaited, never fatal.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
  void (async () => {
    try {
      const { migrateEverythingLive } = await import('./core/kernel/lifecycle-migrate.ts');
      const out = await migrateEverythingLive();
      if (!out.ran) {
        console.error(
          out.reason === 'not-hydrated'
            ? '[lifecycle] migration DEFERRED — the pin index could not be read, so nothing was written. It runs on the next boot; until then a pinned read falls back to the head and says so.'
            : `[lifecycle] migration not needed (${out.reason}).`,
        );
        return;
      }
      console.error(
        `[lifecycle] migration: ${out.pinned} object(s) are now Live across ${out.domains.length} domain(s) — ${JSON.stringify(out.perKind)}${
          out.skipped.length ? ` · skipped: ${out.skipped.join('; ')}` : ''
        }`,
      );
    } catch (err) {
      console.error(`[lifecycle] migration FAILED — nothing was pinned, it retries on the next boot. ${err instanceof Error ? err.message : String(err)}`);
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
              seedWriters: config.trinoSeedWriters,
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

  // ---- stream E: the engineer's door (git → OS) ------------------------------------------
  // APPENDED boot step (shared file; nothing above is reordered). Two jobs, both idempotent:
  //   1. register each object kind's validator + ingest with the receive gate, because a core
  //      module may not import a tab (`registerRepoKind` is the seam — decision D29);
  //   2. make every existing bare repo pushable AND gated (`http.receivepack`, the pre-receive and
  //      post-receive hooks). A repo created later is covered by /api/git/authenticate, which
  //      calls the same function per request.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    void (async () => {
      try {
        const { config } = await import('./core/kernel/config.ts');
        if (!config.dataProjectGit) return;
        const { registerDbtIngest } = await import('./tabs/data/lib/dbt/ingest.ts');
        const { registerAgentSystemIngest } = await import('./tabs/agents/lib/git/ingest.ts');
        registerDbtIngest();
        registerAgentSystemIngest();
        // NIGHT-2 MERGE (E x M x D): the other two kinds the night landed writers for. The METRIC
        // resolver must be installed BEFORE the dashboard kind, because a dashboard push resolves
        // every panel's `metric:<id>` through it and an unwired resolver makes the dashboard ingest
        // refuse the whole push (loudly, with that reason — never by rebinding a panel).
        const { installGovernedRefResolver } = await import('./tabs/metrics/lib/ref-resolver.ts');
        installGovernedRefResolver();
        const { registerSemanticMetricIngest } = await import('./tabs/data/lib/dbt/semantic/receive.ts');
        const { registerDashboardIngest } = await import('./tabs/dashboards/lib/git/receive.ts');
        registerSemanticMetricIngest();
        registerDashboardIngest();
        // WP-54: an app's k8s/ manifests pass the same deploy rules on `git push` as on push_app_files.
        const { registerAppDeployReceive } = await import('./tabs/software/lib/deploy-receive.ts');
        registerAppDeployReceive();
        // Go-live 1: a push to apps/<slug>/ re-derives the app registry (never audience, never retire).
        const { registerAppIngest } = await import('./tabs/software/lib/app-receive.ts');
        registerAppIngest();
        const { ensureReceiveHooks, registeredRepoKinds } = await import('./core/infra/git-receive.ts');
        const { listRepos } = await import('./core/infra/git-store.ts');
        const repos = await listRepos();
        for (const repo of repos) ensureReceiveHooks(repo.name);
        console.info(
          `[os-ui] git receive gate: ${registeredRepoKinds().length} kinds registered (${registeredRepoKinds().map((k) => k.kind).join(', ')}), ` +
            `hooks installed in ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`,
        );
      } catch (err) {
        console.warn(`[os-ui] git receive gate: not armed — ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  // Night 2 (stream G), appended LAST so no existing boot step moves: the generic versioning
  // reads need each tab's object-kind resolver. Never awaited in a way that can fail boot.
  void registerGitObjectKindsAtBoot();
}

/**
 * Night 2 (stream G): register the OBJECT-KIND resolvers the generic versioning reads use.
 *
 * `core/infra/git-objects.ts` holds the kind/layout table and the gate, but the kernel may not
 * import a tab — so each tab hands it a resolver that runs the TAB'S OWN governed read as the
 * calling user. Appended as its own boot step (the shared-file rule: never reorder an existing
 * one), fail-soft: a resolver that cannot be installed leaves its kind answering the typed
 * `kind_not_wired`, which is visible and honest, rather than breaking boot.
 */
export async function registerGitObjectKindsAtBoot(): Promise<void> {
  // Block guard, not an early return — see EDGE-COMPILE GUARD in `register()`.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
  try {
    const { registerAgentSystemGitObject } = await import('./tabs/agents/lib/git/history.ts');
    registerAgentSystemGitObject();
    console.info('[os-ui] git versioning: agent-system registered (history, version, diff)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: agent-system NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  // Night-2 merge (G x S): S's resolver takes `registerGitObject` as a PARAMETER precisely so the
  // Software tab never imports the kernel registry it could not compile against on its own branch.
  // This is the one line that joins them. Registered independently of the one above: a failure in
  // either leaves only ITS kind answering the typed `kind_not_wired`.
  try {
    const { registerGitObject } = await import('./core/infra/git-objects.ts');
    const { installSoftwareGitObject } = await import('./tabs/software/lib/git-object.ts');
    installSoftwareGitObject(registerGitObject);
    console.info('[os-ui] git versioning: software registered (history, version, diff, releases)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: software NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  // Night-2 merge (G x D): the three-line patch stream D's `lib/git/git-object.ts` documents as
  // deviation D-4. The resolver reads through the dashboards store's own visibility gate, so an
  // invisible dashboard is indistinguishable from a missing one (G5).
  try {
    const { registerGitObject } = await import('./core/infra/git-objects.ts');
    const { dashboardGitObjectResolver } = await import('./tabs/dashboards/lib/git/git-object.ts');
    registerGitObject('dashboard', dashboardGitObjectResolver);
    console.info('[os-ui] git versioning: dashboard registered (history, version, diff)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: dashboard NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  // Iteration 2 (checklist G3/G7): the three kinds with a COMMITTED writer and no reader. Each had
  // real files in every domain repo and answered the typed `kind_not_wired`, which is honest but
  // means no history, no diff and no git badge for a dataset, a KPI or a lifecycle pin. Each
  // resolver runs its owner's own governed read AS THE CALLER, and each registration stands alone:
  // a failure in one leaves only ITS kind unwired.
  try {
    const { registerGitObject } = await import('./core/infra/git-objects.ts');
    const { datasetGitObjectResolver } = await import('./tabs/data/lib/git-object.ts');
    registerGitObject('dataset', datasetGitObjectResolver);
    console.info('[os-ui] git versioning: dataset registered (history, version, diff)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: dataset NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { registerGitObject } = await import('./core/infra/git-objects.ts');
    const { metricGitObjectResolver } = await import('./tabs/metrics/lib/git-object-server.ts');
    registerGitObject('metric', metricGitObjectResolver);
    console.info('[os-ui] git versioning: metric registered (history, version, diff)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: metric NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  // The one kind whose writer lives in @core rather than a tab, so its resolver lives beside the
  // writer; the registration still happens HERE, with every other kind.
  try {
    const { registerGitObject } = await import('./core/infra/git-objects.ts');
    const { lifecyclePinGitObjectResolver } = await import('./core/infra/lifecycle-pins.ts');
    registerGitObject('lifecycle-pin', lifecyclePinGitObjectResolver);
    console.info('[os-ui] git versioning: lifecycle-pin registered (history, version, diff)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: lifecycle-pin NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { registerGitObject } = await import('./core/infra/git-objects.ts');
    const { connectionGitObjectResolver } = await import('./tabs/connections/lib/git/git-object.ts');
    registerGitObject('connection-config', connectionGitObjectResolver);
    console.info('[os-ui] git versioning: connection-config registered (history, version, diff)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: connection-config NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { registerGitObject } = await import('./core/infra/git-objects.ts');
    const { metricAlertGitObjectResolver } = await import('./tabs/metrics/lib/git/alerts-git-object.ts');
    registerGitObject('metric-alert', metricAlertGitObjectResolver);
    console.info('[os-ui] git versioning: metric-alert registered (history, version, diff)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: metric-alert NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { registerGitObject } = await import('./core/infra/git-objects.ts');
    const { knowledgeWorkflowGitObjectResolver } = await import('./tabs/knowledge/lib/git/git-object.ts');
    registerGitObject('knowledge-workflow', knowledgeWorkflowGitObjectResolver);
    console.info('[os-ui] git versioning: knowledge-workflow registered (history, version, diff)');
  } catch (err) {
    console.warn(`[os-ui] git versioning: knowledge-workflow NOT registered — ${err instanceof Error ? err.message : String(err)}`);
  }
  }
}
