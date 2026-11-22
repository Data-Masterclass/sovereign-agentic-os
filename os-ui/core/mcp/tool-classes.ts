/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    Tool classes — which model-initiated tool calls need the present user's confirmation.
 * USER STORY: As the owner I want one reviewed, fail-closed answer to "may the assistant run this
 *             without asking me?", so a tool nobody classified is asked about rather than run.
 * ARCHITECTURE: pure lists over the static write catalog; details in the block comment below.
 */
import { WRITE_TOOL_NAMES } from '@core/mcp/write-tool-meta';

/**
 * WHICH TOOL CALLS NEED THE PRESENT USER'S CONFIRMATION — the classification, in production code.
 *
 * GROUNDWORK ONLY. Nothing in production consults `needsUserConfirm` yet: no assistant, no route
 * and no executor imports this module, so no call is confirmed, parked or refused because of it.
 * It exists so the confirmation gate that later PRs wire in has ONE reviewed predicate to ask.
 *
 * WHY NOT `WRITE_TOOL_NAMES`. The write catalog (`write-tool-meta.ts`) answers a different
 * question — "is an AGENT RUN held on this?" — and it is the wrong predicate here in both
 * directions: some tools in it only read (they sit in a write barrel next to the writes they
 * serve), and the reviewed list of reads plus the undecided backlog lived only inside a test.
 * This module moves both lists into production and names the read-shaped exceptions one by one.
 *
 * FAIL-CLOSED. `needsUserConfirm(name)` is `!CONFIRM_FREE.has(name)`: a tool is confirm-free
 * only if it is listed below. An unknown name, a tool added to the registry tomorrow, a backlog
 * tool and every catalogued write all need confirmation until someone reads the handler and
 * lists it here with a reason. `tool-classes.test.ts` pins that every registered tool is in
 * exactly one class, so a new tool cannot be silently confirm-free OR silently unclassified.
 *
 * Pure: no `server-only`, no tab import — the gate (`core/runtime/confirm-gate.ts`) is pure too.
 */

/**
 * Reviewed: read-only against governed state. (A read may still cost model or query budget.)
 * Moved verbatim from `write-tool-meta.test.ts`, where the registry ratchet declared it.
 */
export const READ_TOOLS: readonly string[] = [
  'diff_dataset_data', 'diff_versions', 'get_agent_run', 'get_agent_system', 'get_app_spec', 'get_connection', 'get_cost',
  'get_dagster_run', 'get_dashboard', 'get_dataset', 'get_dataset_versions', 'get_engineering_view', 'get_file', 'get_guide',
  'get_history', 'get_knowledge', 'get_lineage', 'get_metric', 'get_monitoring_overview', 'get_monitoring_panels',
  'get_operating_manual', 'get_policy_view', 'get_request', 'get_run_trace', 'get_software',
  'get_sync_status', 'get_version', 'list_agent_systems', 'list_approvals',
  'list_capabilities', 'list_connection_templates', 'list_connections', 'list_dashboards',
  'list_datasets', 'list_files', 'list_knowledge', 'list_metrics', 'list_operating_manual_versions',
  'list_runs', 'list_software', 'profile_dataset', 'query_data', 'query_metric', 'read_app_files',
  'search_files', 'search_knowledge', 'whoami',
  // Persist nothing, but are not free: each spends reasoning-model budget and returns a candidate
  // or a directive. `generate_app_spec` returns an unsaved AppSpec (`set_app_spec` publishes it);
  // `verify_software` returns the test directive and normalises findings it does not store.
  'generate_app_spec', 'verify_software',
  // Software Factory: `get_app_template` reads the template tree; `verify_app_gates` runs the app's gates in a
  // sandbox Job and stores nothing (it spends compute, like the scan).
  'get_app_template', 'verify_app_gates',
];

/**
 * STATE-CHANGING (or possibly so) and NOT YET CLASSIFIED for the agent hold gate: the hold gate
 * answers "not a write" for each of these under EVERY preset, `read-only` included. Named so they
 * can be decided one by one — not excused. For the USER-confirm question they are fail-closed:
 * a backlog tool needs confirmation.
 *
 * The nine that were here until 2026-11-19 are decided and live in the write catalog now. ONE
 * name took their place, and it came out of READ_TOOLS: a "reviewed read" that turned out not to
 * have been checked is worse than a named unknown.
 */
export const UNCLASSIFIED_BACKLOG: readonly string[] = [
  // Listed as a read until someone looked: it calls `reconcileDeployStatus`, which re-polls the
  // runner and may write the app's deploy fields (the self-healed preview URL) back. Whether that
  // counts as a governed write an agent should be held on is NOT decided — unclassified until it is.
  'get_software_status',
];

/**
 * Tools that sit in the WRITE CATALOG (`WRITE_TOOL_TABS`) and are confirm-free anyway, each with
 * the reason — and each only after its handler was read end to end (2026-11-19) and found to
 * save no governed artifact. They stay in the write catalog: an unattended agent run is still
 * held on them exactly as before. This table is about the present user's confirmation only.
 *
 * Two kinds, kept apart so the reasons stay honest:
 *
 *  (a) READ-SHAPED tools that live in a write barrel beside the writes they serve.
 *  (b) COST-ONLY actions (the owner's decision): they spend query or model budget — which is
 *      metered and audit-traced like any read — but save nothing, so they run freely like reads.
 *
 * NOT here, although they read like (b) — the handler saves something, so they keep needing
 * confirmation: `run_quality_checks` (`runAndRecord` appends a run to the dataset's durable
 * quality series via `recordRun`) and `export_okf_bundle` (`createFile` + `putBlob` create a
 * Personal-tier Files artifact holding the zip). `test_connection` writes the probe status back;
 * `refresh_connection_catalog` and `classify_catalog` replace the cached snapshot/placements.
 */
export const CONFIRM_FREE_CATALOGUED_TOOLS: Readonly<Record<string, string>> = {
  // --- (a) read-shaped, in `core/mcp/experimental/exposure-write-tools.ts` ---
  list_exposure_sets:
    'read: `listExposureSets` checks the caller can see the connection and filters the exposure registry cache; no store write.',
  get_catalog_snapshot:
    'read: `getCatalogSnapshot` returns the cached snapshot (relabelled stale); re-discovery is the separate `refresh_connection_catalog`.',
  get_catalog_classification:
    'read: `getMergedClassification` merges the stored placements with the cached snapshot in memory; running the classifier is the separate `classify_catalog`.',
  list_exposed_tables:
    'read: `listExposedTablesForUser` intersects active exposures with the caller\'s domains; adopting is the separate `adopt_exposed_table`.',
  list_adoptable_actions:
    'read: the same `listExposedTablesForUser` view filtered to operational exposures that carry actions; adopting is the separate `adopt_entity_actions`.',
  // --- (b) cost-only: spends budget, saves nothing ---
  preview_metric:
    'cost-only: builds an unsaved draft measure in memory and runs ONE governed SELECT as the caller (`exploreMetric`); `define_metric` is the save.',
  suggest_metrics:
    'cost-only: `runSuggest` reads the caller\'s visible context and runs the model; candidates are returned as drafts, nothing is defined.',
  propose_quality_fixes:
    'cost-only: `proposeFixes` re-runs one rule, samples rows and asks the model for a proposal; nothing is applied — `apply_quality_fixes` is the write.',
};

/** Every tool the present user's assistant may call WITHOUT a confirmation step. */
export const CONFIRM_FREE: ReadonlySet<string> = new Set([
  ...READ_TOOLS,
  ...Object.keys(CONFIRM_FREE_CATALOGUED_TOOLS),
]);

/**
 * Does a model-initiated call to this tool need the present user's confirmation first?
 * Fail-closed: anything not explicitly listed confirm-free does — unknown names included.
 */
export function needsUserConfirm(name: string): boolean {
  return !CONFIRM_FREE.has(name);
}

/**
 * The ONLY tools an "Allow for this conversation" grant may ever cover (the owner's decision:
 * such a grant is for creating the user's own work in My scope, and for nothing that removes,
 * widens, requests or approves). Deliberately SMALLER than "every My-scope write":
 *
 *   - every entry either creates a NEW artifact that is born Personal/owner-only, or appends a
 *     record without changing an artifact — read in the handler, not inferred from the name;
 *   - EDIT tools are left out even where the owner's intent would cover them (`document_dataset`,
 *     `commit`, `set_app_design`, `commit_agent_files`, `create_dashboard` — which REPLACES by
 *     id, …). The gate decides on the tool NAME and cannot tell the user's Personal artifact from
 *     one already Shared or Certified, so a blanket allowance for an edit tool could silently
 *     cover an edit other people see. An argument-aware gate could widen this; a name-only one
 *     must not;
 *   - never delete / archive / retire / revoke, never a request (`request_deploy`,
 *     `request_promotion`, `request_certification`), never a promotion or approval, and nothing in
 *     `AGENT_FORBIDDEN_TOOLS` or the hold gate's always-confirmed and escalation sets. The tests
 *     pin the disjointness (`tool-classes.test.ts` for the core tables,
 *     `tabs/agents/lib/build/confirm-session-allowable.test.ts` for `hold.ts`).
 *
 * Nothing in production creates such a grant yet. Each entry: name → why it qualifies.
 */
export const SESSION_ALLOWABLE_TOOLS: Readonly<Record<string, string>> = {
  create_dataset: 'creates a NEW private dataset; sharing is the separate promotion path',
  author_knowledge: 'creates a NEW Personal (draft) business process — `createWorkflow`, never an update of an existing one',
  upload_file: 'creates a NEW private file in the Files tab',
  create_agent_system: 'creates a NEW agent system, always My-scope and owner-only',
  create_software: 'creates a NEW app record, Personal until promoted',
  run_quality_checks: 'changes no artifact: runs the rules and appends one run to the quality history',
  export_okf_bundle: 'changes no artifact: writes the export as a NEW Personal-tier file owned by the caller',
};

/** May an "Allow for this conversation" grant cover this tool? By exact own name. */
export function isSessionAllowable(name: string): boolean {
  return Object.hasOwn(SESSION_ALLOWABLE_TOOLS, name);
}

export type ToolClass = 'read' | 'confirm-free-catalogued' | 'write' | 'backlog' | 'unknown';

const READ_SET: ReadonlySet<string> = new Set(READ_TOOLS);
const BACKLOG_SET: ReadonlySet<string> = new Set(UNCLASSIFIED_BACKLOG);

/**
 * The ONE class a tool name falls in, for the confirm question. `unknown` is a name in none of
 * the lists (not registered, or registered and not yet classified) — it needs confirmation.
 * By exact own name: the sets are `Set`s, so `constructor`/`__proto__` are simply unknown.
 */
export function toolClass(name: string): ToolClass {
  if (Object.hasOwn(CONFIRM_FREE_CATALOGUED_TOOLS, name)) return 'confirm-free-catalogued';
  if (READ_SET.has(name)) return 'read';
  if (BACKLOG_SET.has(name)) return 'backlog';
  if (WRITE_TOOL_NAMES.has(name)) return 'write';
  return 'unknown';
}
