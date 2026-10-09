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
  create_big_bet: 'bigbets',
  attach_component: 'bigbets',
  attach_bet_component: 'bigbets',
  set_bet_workflow: 'bigbets',
  wire_bet_components: 'bigbets',
  unwire_bet_components: 'bigbets',
  update_big_bet: 'bigbets',
  archive_big_bet: 'bigbets',
  unarchive_big_bet: 'bigbets',
  delete_big_bet: 'bigbets',
  restore_big_bet_version: 'bigbets',
  create_agent_system: 'agents',
  commit_agent_files: 'agents',
  build_agent_system: 'agents',
  run_agent_system: 'agents',
  create_model: 'science',
  train_model: 'science',
  get_model_status: 'science',
  request_promotion: 'data',
  approve_promotion: 'data',
  set_app_design: 'software',
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
  create_pillar: 'strategy',
  update_pillar: 'strategy',
  link_bet_to_pillar: 'strategy',
  record_value_entry: 'strategy',
  set_pillar_target: 'strategy',
  archive_pillar: 'strategy',
  unarchive_pillar: 'strategy',
  delete_pillar: 'strategy',
  promote_pillar: 'strategy',
  demote_pillar: 'strategy',
  restore_pillar_version: 'strategy',
  rate_listing: 'marketplace',
};

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(WRITE_TOOL_TABS));
