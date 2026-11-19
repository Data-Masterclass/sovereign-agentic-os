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
  author_knowledge: 'knowledge',
  publish_knowledge: 'knowledge',
  index_knowledge: 'knowledge',
  retire_knowledge: 'knowledge',
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
  //   REFUSED to agent runs         | decide_deploy, promote                  | AGENT_FORBIDDEN_TOOLS below
  //   HELD under every preset       | delete, archive, request_deploy         | hold.ts ALWAYS_CONFIRMED_TOOLS
  //   My-scope (read-only holds)    | create_software, start_preview, use_*   | hold.ts default (`personal`)
  //
  // The six personal ones mirror `set_app_spec` above, with the SAME known limit: the hold is
  // name-only, so it cannot tell the runner's Personal app from one already Shared or Certified.
  create_software: 'software',
  start_preview: 'software',
  use_connection: 'software',
  use_data: 'software',
  use_knowledge: 'software',
  use_as_data: 'software',
  request_deploy: 'software',
  archive: 'software',
  delete: 'software',
  decide_deploy: 'software',
  promote: 'software',
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
 * TWO doors consult this:
 *   1. `tabs/agents/lib/build/os-tools.ts` — gate 0 of the agent system's tool executor refuses
 *      the call, and `grantedMcpTools` drops the tool from the schemas a model is offered (a
 *      model will try whatever it can see).
 *   2. `tabs/software/lib/app-tool-call.ts` — `callAppTool` refuses a tool of the same NAME before
 *      any authorization. That door executes an APP's own tools, so the OS tools above are not
 *      behind it; what it closes is an `actions.yml` declaring an action called `promote` or
 *      `reindex_corpus`, which would read like the real thing in a trace and an approval inbox
 *      while doing something else entirely.
 *
 * It lives here rather than in either tab for the same reason `WRITE_TOOL_TABS` does — a core
 * table, independent of which bundles happen to be registered. Every entry must ALSO be in
 * `WRITE_TOOL_TABS` and company-scoped in `hold.ts`, so a door that forgets this table still
 * parks the call for a platform admin instead of running it.
 */
export const AGENT_FORBIDDEN_TOOLS: Readonly<Record<string, string>> = {
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
};

/** The reason this tool is closed to agent runs, or null when it is not. Fail-closed by name. */
export function agentForbiddenReason(name: string): string | null {
  return AGENT_FORBIDDEN_TOOLS[name] ?? null;
}
