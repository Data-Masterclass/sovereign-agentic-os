/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * GRANTS → RUNTIME TOOL ACCESS (pure, unit-tested).
 *
 * The audit finding this closes: `app.grants` (the five governed context kinds a
 * Software app may use) was STORED but never turned into the deployed app's actual
 * tool access — the app's OPA capability profile was compiled from its TEMPLATE
 * tools only, so a granted dataset / knowledge base / metric bought the app nothing
 * at runtime.
 *
 * This module derives the DATA-PLANE tools a grant implies, using the SAME mapping
 * conventions the Agents builder already proved (lib/agents/build/os-tools.ts):
 * granting a kind enables that kind's governed OS tools, and every action tool pulls
 * in its read-only DISCOVERY COMPANIONS so the app can LEARN the exact resource
 * (dataset FQN, metric member) before acting instead of guessing. Connections map to
 * their per-connection `connection_<id>` tool, exactly as an agent's connection grant
 * does.
 *
 * The result MERGES with the app's template tools (the baseline surface); grants only
 * ADD data-plane access. Fail-closed: no grants ⇒ no data-plane tools ([]), so an app
 * that grants nothing keeps exactly its template default. Per-artifact DLS/RLS still
 * governs which rows/ids the tool can actually reach at call time (run-as-user) — this
 * profile only widens WHICH TOOLS are exposed, never the identity the call runs as.
 *
 * Pure (no server-only imports) so it is trivially unit-testable and shared by the
 * deploy-time compile AND the recompile-on-grant-change path.
 */

import type { ContextGrants, ContextKind } from '@/lib/core/context-grants';
import type { AppTool } from '@/lib/infra/app-registry';

/**
 * The governed OS tools a granted KIND enables. An `action` tool is the thing the
 * grant is FOR (query a dataset, search knowledge, slice a metric); its `discovery`
 * companions are the read-only list/inspect tools that let the app resolve the exact
 * resource first (mirrors DISCOVERY_COMPANIONS in the Agents builder). All are read
 * tools — a granted context kind never auto-enables a write (the least-privilege
 * default; a write graduates through the Builder review, like every app write tool).
 */
const KIND_TOOLS: Record<Exclude<ContextKind, 'connections'>, { action: string[]; discovery: string[] }> = {
  // Data: query the governed rows; discover the dataset + its physical FQN/columns first.
  data: { action: ['query_data'], discovery: ['list_datasets', 'get_dataset', 'profile_dataset'] },
  // Knowledge: semantic search over the DLS-scoped index; browse the catalog first.
  knowledge: { action: ['search_knowledge'], discovery: ['list_knowledge'] },
  // Files: read a specific file's content; enumerate/search before reading.
  files: { action: ['get_file'], discovery: ['list_files', 'search_files'] },
  // Metrics: slice a governed metric; list the metric registry first.
  metrics: { action: ['query_metric'], discovery: ['list_metrics'] },
};

/** A short, honest description for each derived tool, so the Connections surface reads clearly. */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  query_data: 'Query granted governed datasets (NL→SQL, run as the app user, DLS/RLS-scoped).',
  list_datasets: 'List datasets the app may see (discovery for query_data).',
  get_dataset: 'Inspect a granted dataset (schema + physical FQN) before querying.',
  profile_dataset: 'Profile a granted dataset (column stats) before querying.',
  search_knowledge: 'Semantic search over the app\'s granted knowledge (DLS-scoped).',
  list_knowledge: 'Browse the knowledge catalog (discovery for search_knowledge).',
  get_file: 'Read a granted file\'s content (DLS-scoped).',
  list_files: 'List files the app may see (discovery for get_file).',
  search_files: 'Search granted files (discovery for get_file).',
  query_metric: 'Slice a granted governed metric (run as the app user).',
  list_metrics: 'List metrics the app may see (discovery for query_metric).',
};

/**
 * The data-plane tools implied by an app's grants — READ-ONLY, deduped, in a stable
 * order (data → knowledge → files → metrics → connections). Empty grants ⇒ []. Every
 * kind with at least one grant contributes its action tool plus its discovery
 * companions; each granted connection contributes its `connection_<id>` tool. Callers
 * MERGE this with the app's template tools before compiling the OPA profile.
 */
export function dataPlaneToolsFromGrants(grants: ContextGrants): AppTool[] {
  const out: AppTool[] = [];
  const seen = new Set<string>();
  const push = (name: string, description: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    // Data-plane grants never auto-enable a write (least privilege): reads only.
    out.push({ name, description, write: false });
  };

  for (const kind of ['data', 'knowledge', 'files', 'metrics'] as const) {
    if (grants[kind].length === 0) continue;
    const map = KIND_TOOLS[kind];
    for (const name of [...map.action, ...map.discovery]) {
      push(name, TOOL_DESCRIPTIONS[name] ?? `Governed ${kind} tool.`);
    }
  }

  // Connections map to their own per-connection governed tool (like an agent's
  // connection grant → `connection_<id>`), so the app can call exactly the granted
  // connections and nothing else.
  for (const g of grants.connections) {
    push(`connection_${g.id}`, `Call the granted connection ${g.id} (governed by its own capability profile).`);
  }

  return out;
}
