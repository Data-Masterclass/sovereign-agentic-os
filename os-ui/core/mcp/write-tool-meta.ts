/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */

/**
 * STATIC catalog of the governed WRITE tools: name → the tab the write lands in.
 *
 * Deliberately independent of bundle registration. Whether a write tool needs
 * Governance approval when an agent calls it ("is it a write action?") must never
 * depend on whether its bundle happens to be registered ("is its feature on?") —
 * conflating the two could let a write skip the approval hold. So the approval
 * path (`lib/agents/tool-catalog.ts`, `lib/agents/build/os-tools.ts`) reads THIS
 * table, imports no tab module, and fails safe: a write is held even when its
 * bundle is off.
 *
 * `write-tool-meta.test.ts` asserts this table equals ALL_WRITE_TOOLS exactly
 * (names and tabs), so adding/removing/retabbing a write tool without updating
 * it fails CI.
 */
export const WRITE_TOOL_TABS: Readonly<Record<string, string>> = {
  create_dataset: 'data',
  add_dataset_version: 'data',
  document_dataset: 'data',
  ingest_dataset: 'data',
  transform_silver: 'data',
  build_gold_join: 'data',
  define_quality_rules: 'data',
  run_quality_checks: 'data',
  propose_quality_fixes: 'data',
  apply_quality_fixes: 'data',
  retire_dataset: 'data',
  set_dataset_sync: 'data',
  sync_dataset_now: 'data',
  reconcile_domain_tables: 'data',
  rollback_dataset_version: 'data',
  tag_dataset_version: 'data',
  // A workflow (the documentation of a business process) is its own artifact with its own tab; a
  // note is saved with `save_knowledge_note`. The `*_knowledge` spellings of the four tools below
  // are deprecated aliases (`@core/mcp/deprecated-aliases`) and resolve to these before any table.
  author_workflow: 'workflows',
  // A titled markdown note in the caller's own My knowledge — a My-scope write like
  // `author_workflow` (read-only holds it; otherwise the runner's own rights decide).
  save_knowledge_note: 'knowledge',
  publish_workflow: 'workflows',
  index_workflow: 'workflows',
  retire_workflow: 'workflows',
  export_okf_bundle: 'knowledge',
  import_okf_bundle: 'knowledge',
  upload_file: 'files',
  suggest_metrics: 'metrics',
  define_metric: 'metrics',
  preview_metric: 'metrics',
  promote_metric: 'metrics',
  create_dashboard: 'dashboards',
  create_agent_system: 'agents',
  commit_agent_files: 'agents',
  build_agent_system: 'agents',
  run_agent_system: 'agents',
  // A2: resuming a parked/interrupted run executes the system — a write like run_agent_system.
  resume_agent_run: 'agents',
  request_promotion: 'data',
  approve_promotion: 'data',
  set_app_design: 'software',
  // `commit` writes an app's SOURCE FILES. It is a PLATFORM-MCP tool (declared `write: true` in
  // `tabs/software/lib/platform-mcp.ts` and registered as the `platform` bundle), so it is NOT in
  // `ALL_WRITE_TOOLS` — and this table is what the agent hold gate reads (`hold.ts` `isWriteTool`).
  // While it was missing here, `holdDecisionFor(preset,'commit')` answered "not a write" for EVERY
  // preset, so a `read-only` agent granted `commit` could write app files unheld. Added by the
  // night-2 app-builder stream (review H-1). See `write-tool-meta.test.ts` for why the equality
  // assertion now has two sources, and `tabs/agents/lib/builtin/appsmith.test.ts` for the posture
  // this produces (read-only: HELD; other presets: a My-scope write, so not held — gate 2 rules).
  commit: 'software',
  // NIGHT-2 MERGE (S x H): `push_app_files` is the OTHER door onto the same bytes — it writes an
  // app's SOURCE TREE through `commitSubtree('apps/<slug>')`. Stream S added it to the platform-MCP
  // surface with `write: true`; H's H-1 tripwire in `tabs/software/lib/builder/dispatch.test.ts`
  // caught that it was not classified here, which is EXACTLY the gap H-1 closed for `commit`: the
  // hold gate reads this table, so an unclassified platform write answers "not a write" for every
  // preset and a `read-only` agent granted it could write app files unheld. Classified rather than
  // excused. The shipped Software Delivery Team grants `commit`, not this, so no golden moves.
  push_app_files: 'software',
  // 2026-11-19 — THE FOURTH OCCURRENCE of "in the catalog != held" (after `commit`,
  // `push_app_files` and `reindex_corpus`). `set_app_spec` PUBLISHES: it writes the app's LIVE
  // served surface and snapshots a version, so the app is immediately reachable at
  // `/apps/<slug>` by everyone its visibility admits. It is declared `write: true` on the
  // platform-MCP surface, but the hold gate reads THIS table — so while it was missing,
  // `holdDecisionFor(preset,'set_app_spec')` answered "not a write" for EVERY preset and an agent
  // granted it, INCLUDING under `read-only`, could publish a live app with no hold. That
  // contradicts the owner's standing rule that writes happen only on explicit confirmation.
  // No golden moves: a tree-wide search finds no system granting `set_app_spec`.
  //
  // KNOWN LIMIT, stated precisely rather than overclaimed: classifying it here makes `read-only`
  // hold it, and leaves `read-propose`/`full-in-scope` treating it as a My-scope write. That is
  // right for a Personal app. On an app ALREADY Shared or Certified it is NOT a full answer —
  // publishing pushes a new live surface to that existing audience. It does not CHANGE
  // `visibility` (that is `promote`, separately gated), but the audience is already there. The
  // hold is name-only (`tabs/agents/lib/build/hold.ts` is pure and sees no arguments), so it
  // cannot distinguish the two. Follow-up specified in the plan, §4.7.
  //
  // The OTHER two spec doors need no entry here and must not get one: `publishApp` and
  // `saveAppDraft` are HTTP routes (`/api/apps/[id]/publish`, `…/spec/draft`), not governed MCP
  // tools, so no agent can reach them and this table — which only classifies MCP tool names —
  // has nothing to say about them. `tabs/software/lib/builder/dispatch.test.ts` is the ratchet
  // that keeps the remaining unclassified platform writes named.
  set_app_spec: 'software',
  // 2026-11-19 — the FIFTH, and the unclassified TWIN of `set_app_design` right above. Both doors
  // land in the SAME governed write (`patchAppDesign`): `set_app_design` is the tab's own MCP tool
  // and was classified; `design_software` is the platform-MCP tool onto the same function and was
  // not — so the hold posture of one write depended on which of its two names an agent used.
  // It matters more since F10: this door now DEFAULTS a grant with no `access` to `read-only`
  // instead of dropping it, so an unheld call can bind governed context the caller never
  // explicitly authorised. Same posture as its twin (read-only holds; otherwise a My-scope
  // write). No golden moves: nothing grants `design_software`.
  design_software: 'software',
  // 2026-11-19 — THE REMAINING ELEVEN platform-MCP writes, which takes the ratchet in
  // `tabs/software/lib/builder/dispatch.test.ts` to ZERO. All were declared `write: true` and
  // absent here, so `holdDecisionFor(preset, name)` answered "not a write" under every preset,
  // `read-only` included. Being listed here is only step one — "in the catalog is not held" has
  // now cost five times — so each carries a posture the owner decided, enforced elsewhere:
  //
  //   posture                       | tools                                   | enforced by
  //   ------------------------------|-----------------------------------------|---------------------------
  //   REFUSED at agent-run doors    | decide_deploy, promote                  | AGENT_FORBIDDEN_TOOLS below
  //   HELD under every preset       | delete, archive, request_deploy         | hold.ts ALWAYS_CONFIRMED_TOOLS
  //   My-scope (read-only holds)    | create_software, start_preview, use_*   | hold.ts default (`personal`)
  //
  // The six personal ones mirror `set_app_spec` above, with the SAME known limit: the hold is
  // name-only, so it cannot tell the runner's Personal app from one already Shared or Certified.
  create_software: 'software',
  start_preview: 'software',
  // Software Factory: starts a sandbox Job (2 CPU / 2Gi). Persists nothing, but it spends cluster compute,
  // so it is a governed action (confirmation, held like `start_preview`), not a free read.
  verify_app_gates: 'software',
  use_connection: 'software',
  use_data: 'software',
  use_knowledge: 'software',
  use_as_data: 'software',
  request_deploy: 'software',
  archive: 'software',
  delete: 'software',
  decide_deploy: 'software',
  promote: 'software',
  // The two APPROVAL verbs outside the platform surface (review H2). Neither is in `ALL_WRITE_TOOLS`
  // — `decide_approval` is a governance tool, `promote_connection` lives with the connection
  // discovery tools — so, like the platform writes, they are classified here by name. Both are
  // closed to agent runs below; the entry is what makes the hold the second line behind that.
  decide_approval: 'governance',
  promote_connection: 'connections',
  list_exposure_sets: 'connections',
  create_exposure_set: 'connections',
  update_exposure_set: 'connections',
  revoke_exposure_set: 'connections',
  get_catalog_snapshot: 'connections',
  refresh_connection_catalog: 'connections',
  get_catalog_classification: 'connections',
  classify_catalog: 'connections',
  list_exposed_tables: 'data',
  adopt_exposed_table: 'data',
  list_adoptable_actions: 'connections',
  adopt_entity_actions: 'connections',
  // Lifecycle (night 2) — change what RUNS, not who may use it.
  go_live: 'governance',
  retire: 'governance',
  // 2026-11-19: the admin re-index REWRITES index rows, so the hold gate must see it as a write.
  // It is not in `ALL_WRITE_TOOLS` because it is built by a FACTORY over the two tab-owned
  // services (`core/mcp/reindex-tools.ts`) — one tool cannot live in either tab and the kernel may
  // not import one — so it is classified here deliberately, for exactly the reason H-1 classified
  // `commit`: an unclassified write answers "not a write" for every preset and would run unheld.
  reindex_corpus: 'files',
  // Delete domain (admin): removes a domain and everything in it — the hold gate must see a write.
  delete_domain: 'governance',
  // App Builder (F): an admin changes the global go-live rule table — a tenant-wide governance write.
  set_go_live_rules: 'governance',
  // App Builder (D): an app's env/secrets and its own database (tabs/software/mcp/app-builder/d-tools.ts, in the
  // software write barrel). The three writes change the app's Kubernetes Secrets / CNPG objects and roll the app, so
  // the hold gate must see them as writes; the two reads sit in the same barrel (confirm-free, each with its listed
  // reason in the confirm classes).
  list_app_env: 'software',
  get_app_database: 'software',
  set_app_env: 'software',
  unset_app_env: 'software',
  create_app_database: 'software',
  // 2026-11-19 — THE NINE-TOOL BACKLOG, DECIDED. These were in the MCP registry and in no hold
  // table (they are not in `ALL_WRITE_TOOLS`, and `build_software` declares `write: false`), so
  // the gate answered "not a write" for each under every preset. The registry ratchet in
  // `write-tool-meta.test.ts` had them on a named backlog; the owner decided each one:
  //
  //   posture                       | tools                                        | enforced by
  //   ------------------------------|----------------------------------------------|---------------------------
  //   REFUSED at agent-run doors    | revoke_action_adoption                       | AGENT_FORBIDDEN_TOOLS below
  //   HELD under every preset       | retire_connection, request_certification     | hold.ts ALWAYS_CONFIRMED_TOOLS → domain_admin
  //   HELD under every preset       | update_operating_manual,                     | hold.ts ALWAYS_CONFIRMED_TOOLS + ADMIN_CONFIRMED_TOOLS
  //                                 | restore_operating_manual_version             |   → platform admin
  //   My-scope (read-only holds)    | create_connection, configure_connection,     | hold.ts default (`personal`)
  //                                 | test_connection, build_software              |
  //
  // The four personal ones carry the SAME known limit as `set_app_spec`: the hold is name-only, so
  // it cannot tell the runner's Personal connection from one already Shared or Certified (gate 2 —
  // the runner's own edit rights — is what stands between). `test_connection` is a probe that
  // writes the connection's status back; under `read-only` it is now held like any other write.
  // These rules bind AGENT runs only — a person keeps all nine in the UI and in their own MCP session.
  revoke_action_adoption: 'connections',
  retire_connection: 'connections',
  request_certification: 'governance',
  update_operating_manual: 'operating-manual',
  restore_operating_manual_version: 'operating-manual',
  create_connection: 'connections',
  configure_connection: 'connections',
  test_connection: 'connections',
  build_software: 'software',
};


export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(WRITE_TOOL_TABS));

/**
 * Writes an UNATTENDED AGENT RUN may not perform at all — name → the reason a caller is told.
 *
 * Being in {@link WRITE_TOOL_TABS} makes a tool HELD; it does not make it unavailable, and for
 * the tools below "held" is not enough on its own.
 *
 *   - `reindex_corpus` — its effect is not an artifact in a lane: it re-parses and re-embeds EVERY
 *     selected row of a tenant's Files or Knowledge index and spends real embeddings budget doing
 *     it. There is no version of that which belongs to an agent loop deciding on its own that the
 *     corpus looks wrong. An admin runs it from Platform → Re-index, the admin HTTP door, or their
 *     own MCP session — all three of which are a person, present, choosing.
 *   - `decide_deploy`, `promote` — APPROVALS. An approval is a human decision, and four-eyes has
 *     to mean two humans. Holding an agent's approval does not preserve that: the person who
 *     approves the hold is approving "let the agent approve", so the go-live or the wider audience
 *     ends up resting on ONE human judgement while the record shows a request, an approval and a
 *     confirmation. So an agent may REQUEST (`request_deploy`, `request_promotion` — both held)
 *     and may never decide. The same tools stay fully available to a person in the UI or in
 *     their own MCP session; this table is consulted only at agent-facing doors.
 *
 *   - `decide_approval`, `promote_connection` — the same principle outside the software tab:
 *     `decide_approval` decides ANY queued request (and executes its effect on approve);
 *     `promote_connection` is itself the domain-admin approval of a connection's My → Domain step.
 *
 *   - `revoke_action_adoption` — the INVERSE of an approval, and closed for the same reason an
 *     approval is: it is a domain admin withdrawing what their domain adopted, after which the
 *     domain can no longer arm those write actions. That is a governance decision about other
 *     people's work, not a step in an agent's own task. (Not four-eyes — one person decides
 *     it — so its reason does not claim that.)
 *
 * WHICH DOORS CONSULT THIS — exactly three, and what is NOT covered:
 *   1. AGENT SYSTEM RUNS — `tabs/agents/lib/build/os-tools.ts`: gate 0 of `grantedToolExecutor`
 *      refuses the call, and `grantedMcpTools` drops the tool from the schemas a model is
 *      offered (a model will try whatever it can see). This is every run of a system.yaml:
 *      the engine, a schedule, `run_agent_system`.
 *   2. THE SOFTWARE TEAM PANEL — `tabs/agents/lib/build/phase-tools.ts` (`phaseToolExecutor`,
 *      wired in `runPhaseTurn`): the interactive, one-agent-per-turn builder refuses these names
 *      and anything the turn's agent was not offered. It parks nothing for a second person;
 *      instead `request_deploy` waits for the present user's own Confirm — see that file.
 *   3. APP TOOL CALLS — `tabs/software/lib/app-tool-call.ts`: `callAppTool` refuses a tool of the
 *      same NAME before any authorization, and `parseAppActions` rejects an `actions.yml` action
 *      declared under one. That door executes an APP's own tools, so the OS tools above are not
 *      behind it; what it closes is an app tool that would read like the real thing in a trace
 *      and an approval inbox while doing something else entirely.
 *
 * OUT OF SCOPE, on purpose and stated so nobody reads "refused" as "everywhere": the
 * INTERACTIVE ASSISTANTS — Ask the OS (`runOsAssistant`, `core/runtime/agent-loop.ts`) and the
 * per-tab assistant (`runTabAgent`, `core/runtime/runtime.ts`, via `/api/agent-chat` and the app
 * Build chat). They offer the present user's role-scoped registry and dispatch through
 * `handleRpc` as that user; they consult neither this table nor the hold table. A person is
 * present, and every write there parks behind the user-confirm gate
 * (`core/runtime/confirm-gate.ts`) until that person confirms it. Neither does `handleRpc` itself, the MCP HTTP door or any UI route
 * consult this table: a person keeps every one of these tools, under their own role gates.
 *
 * It lives here rather than in a tab for the same reason `WRITE_TOOL_TABS` does — a core
 * table, independent of which bundles happen to be registered. Every entry must ALSO be in
 * `WRITE_TOOL_TABS` and company-scoped in `hold.ts`, so a door that forgets this table still
 * parks the call for a platform admin instead of running it.
 */
export const AGENT_FORBIDDEN_TOOLS: Readonly<Record<string, string>> = {
  set_go_live_rules:
    'set_go_live_rules is an operator act, not an agent action: it decides who must review every ' +
    'go-live in the tenant. A platform admin changes it in the Go-live rules section of the ' +
    'Platform tab or from their own MCP session.',
  delete_domain:
    'delete_domain is an operator act, not an agent action: it removes a whole domain and every ' +
    'artifact in it. A platform admin runs it from Admin → Domains or their own MCP session.',
  reindex_corpus:
    'reindex_corpus is an operator act, not an agent action: it re-parses and re-embeds every ' +
    'selected row of a tenant corpus and spends real embeddings budget. An unattended run may ' +
    'not start one. A platform admin runs it from Platform → Re-index, from ' +
    'POST /api/platform-admin/reindex, or from their own MCP session.',
  decide_deploy:
    'decide_deploy is a human decision, not an agent action: approving or denying a go-live is ' +
    'the review gate itself, and four-eyes means two people — never a person and their agent. ' +
    'An agent run may request a deploy (request_deploy) and must stop there. A Builder or Admin ' +
    'decides it in Software → the app → Review, or from their own MCP session.',
  promote:
    'promote is a human decision, not an agent action: it widens who an app reaches (My → Domain ' +
    '→ Company), and the four-eyes on that step means two people — never a person and their ' +
    'agent. An agent run may not climb the ladder. The owner or an admin promotes the app in ' +
    'Software → the app, or from their own MCP session.',
  decide_approval:
    'decide_approval is a human decision, not an agent action: it approves or denies a queued ' +
    'request and, on approve, executes its effect. The four-eyes on a request means two people ' +
    '— never a person and their agent. An agent run may file requests and must stop there. ' +
    'An entitled person decides in Governance → Inbox, or from their own MCP session.',
  promote_connection:
    'promote_connection is a human decision, not an agent action: it is the domain admin\'s ' +
    'approval that turns a personal connection into a shared domain data source, and the ' +
    'four-eyes on that step means two people — never a person and their agent. A domain ' +
    'admin promotes it in Connections, or from their own MCP session.',
  revoke_action_adoption:
    'revoke_action_adoption is a human decision, not an agent action: it withdraws a domain\'s ' +
    'adoption of an exposed entity\'s write actions, after which the domain can no longer arm ' +
    'them. That is a domain admin\'s governance decision — the inverse of an approval — and an ' +
    'agent run may not take it. A domain admin of the adopting domain revokes it from the ' +
    'connection\'s expose panel in Connections, or from their own MCP session.',
};

/** The reason this tool is closed to agent runs, or null when it is not. By exact own name. */
export function agentForbiddenReason(name: string): string | null {
  // `Object.hasOwn`, not a bare lookup: `AGENT_FORBIDDEN_TOOLS['constructor']` is a function and
  // `['__proto__']` an object, so an indexed read answered "forbidden" (truthy, and not a string)
  // for names inherited from Object.prototype. A tool or an app action can be called `constructor`.
  return Object.hasOwn(AGENT_FORBIDDEN_TOOLS, name) ? AGENT_FORBIDDEN_TOOLS[name] : null;
}
