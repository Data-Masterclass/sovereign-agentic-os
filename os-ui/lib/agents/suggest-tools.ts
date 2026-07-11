/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Deterministic tool suggestion for Simple mode (the non-coder builder). Given an
 * agent's role/name/instructions text, propose a small, sensible set of tool
 * grants — so a first-time builder never has to hunt through the full MCP catalog.
 *
 * This is a PURE module (no server/network deps) so it is shared by the Simple
 * builder UI and its unit tests. It is advisory only: the suggestions are shown as
 * chips the user accepts/toggles, and whatever they keep is written as ordinary
 * `grants.tools` through the SAME commit path Developer mode's Grants panel uses.
 * The compiler still enforces narrow-only + role floors regardless of what is
 * suggested here — this never grants authority, it only proposes it.
 *
 * The mapping is keyword → canonical OS MCP tool names (all read-oriented, so
 * suggestions stay safe-by-default; write tools are added deliberately in the
 * Grants panel, not auto-suggested).
 */

/** One capability the builder might want, keyed by plain-language intent. */
type Suggestion = {
  /** Canonical MCP tool name (must exist in the catalog to be surfaced). */
  tool: string;
  /** Lowercased keywords in role/instructions that pull this tool in. */
  keywords: string[];
  /** Short, plain-language reason shown next to the chip. */
  why: string;
};

/**
 * The catalogue of read-oriented suggestions, richest first. Keywords are matched
 * as substrings against the lowercased role+instructions text, so "analyze",
 * "analysis" and "analyst" all hit "analy".
 */
const SUGGESTIONS: Suggestion[] = [
  { tool: 'query_data', keywords: ['analy', 'data', 'query', 'sql', 'number', 'metric', 'report', 'chart', 'trend', 'figure'], why: 'run queries over datasets' },
  { tool: 'list_datasets', keywords: ['analy', 'data', 'dataset', 'source', 'table', 'explore'], why: 'find the datasets available' },
  { tool: 'profile_dataset', keywords: ['analy', 'data', 'profile', 'quality', 'column', 'schema'], why: 'inspect a dataset before using it' },
  { tool: 'query_metric', keywords: ['metric', 'kpi', 'measure', 'trend', 'report'], why: 'read a defined metric' },
  { tool: 'list_metrics', keywords: ['metric', 'kpi', 'measure'], why: 'find the metrics available' },
  { tool: 'search_knowledge', keywords: ['knowledge', 'rule', 'policy', 'document', 'doc', 'guide', 'research', 'lookup', 'context', 'faq', 'sop', 'reference'], why: 'search the knowledge base' },
  { tool: 'search_files', keywords: ['file', 'document', 'attachment', 'pdf', 'upload', 'find'], why: 'find relevant files' },
  { tool: 'get_file', keywords: ['file', 'document', 'attachment', 'pdf', 'read'], why: 'read a specific file' },
  { tool: 'upload_file', keywords: ['write', 'draft', 'produce', 'output', 'save', 'deliver', 'report', 'summary', 'export'], why: 'save its output as a file' },
  { tool: 'list_connections', keywords: ['connect', 'integration', 'source', 'system', 'external', 'api'], why: 'see connected systems' },
];

/**
 * Suggest a tool grant set from an agent's role/name/instructions, intersected
 * with the tools that are actually available (the catalog the user may grant, and
 * — when narrowing further — the system's own grants). Returns each suggested tool
 * with a plain-language reason, de-duplicated and in a stable catalogue order.
 *
 * @param text      any concatenation of the agent's id/role/instructions
 * @param available the tool names the caller is allowed to suggest from (the
 *                  role-scoped catalog). When omitted, all mapped tools are eligible.
 */
export function suggestTools(
  text: string,
  available?: readonly string[],
): { tool: string; why: string }[] {
  const t = (text || '').toLowerCase();
  const allow = available ? new Set(available) : null;
  const out: { tool: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const s of SUGGESTIONS) {
    if (seen.has(s.tool)) continue;
    if (allow && !allow.has(s.tool)) continue;
    if (s.keywords.some((k) => t.includes(k))) {
      out.push({ tool: s.tool, why: s.why });
      seen.add(s.tool);
    }
  }
  // Sensible floor: an agent with NO keyword hit still gets knowledge search — the
  // most universally useful read tool — if it is available. Keeps a fresh agent
  // useful instead of tool-less.
  if (out.length === 0) {
    const fallback = 'search_knowledge';
    if (!allow || allow.has(fallback)) out.push({ tool: fallback, why: 'search the knowledge base' });
  }
  return out;
}

/** Just the tool names from {@link suggestTools} — convenience for writing grants. */
export function suggestToolNames(text: string, available?: readonly string[]): string[] {
  return suggestTools(text, available).map((s) => s.tool);
}
