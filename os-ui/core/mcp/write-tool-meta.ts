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
};


export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(WRITE_TOOL_TABS));
