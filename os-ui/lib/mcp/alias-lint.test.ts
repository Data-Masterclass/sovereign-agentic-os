/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Alias collision lint — guards the "(also called: …)" synonym parentheticals
 * added to MCP tool descriptions in the synonym-sweep.
 *
 * Two assertions:
 *   A) No alias string appears in TWO different families' parentheticals.
 *   B) Each family's canonical aliases (from the approved map below) all appear
 *      in that family's primary tools' descriptions.
 *
 * The approved map IS the source of truth — update it here when the map changes,
 * not scattered across tool files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub fetch before any store import (the server imports store modules at load time).
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

import { ALL_MCP_TOOLS } from './server.ts';

// ─── Approved alias map ────────────────────────────────────────────────────────
// key = family label; value = aliases that MUST appear in the family's primary
// tools (exact lowercase match after normalisation).
const ALIAS_MAP: Record<string, string[]> = {
  dataset: ['table', 'data product'],
  curated_dataset: ['360 view', 'data mart', 'aggregated dataset', 'platinum dataset'],
  metric: ['kpi', 'measure', 'indicator'],
  dashboard: ['report', 'business intelligence (bi)', 'data visualization'],
  big_bet: ['initiative', 'strategic investment', 'project'],
  pillar: ['strategic goal', 'objective', 'north star'],
  agent_system: ['ai team', 'assistant team'],
  connection: ['integration', 'data source', 'google', 'microsoft', 'aws', 'snowflake', 'databricks'],
  // Business process / workflow family: the rename wave added "workflow, process workflow";
  // the synonym sweep extends to include SOP.
  business_process: ['workflow', 'process workflow', 'sop (standard operating procedure)'],
  sync: ['refresh', 'data pipeline', 'etl'],
};

// Primary tools that carry each family's aliases (create / list / get).
// Tools not listed here are secondary and are intentionally kept clean.
const FAMILY_PRIMARY_TOOLS: Record<string, string[]> = {
  dataset: ['create_dataset', 'list_datasets', 'get_dataset'],
  curated_dataset: ['build_gold_join'],
  metric: ['define_metric', 'list_metrics', 'get_metric', 'query_metric'],
  dashboard: ['create_dashboard', 'list_dashboards', 'get_dashboard'],
  big_bet: ['create_big_bet', 'list_big_bets', 'get_big_bet'],
  pillar: ['create_pillar', 'list_pillars', 'get_pillar'],
  agent_system: ['create_agent_system', 'list_agent_systems', 'get_agent_system'],
  connection: ['create_connection', 'list_connections', 'get_connection', 'list_connection_templates'],
  business_process: ['author_knowledge', 'list_knowledge', 'get_knowledge'],
  sync: ['set_dataset_sync', 'sync_dataset_now', 'get_sync_status'],
};

/** Split a string on top-level commas only (commas inside nested parens are skipped). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Extract all "(also called: …)" parenthetical bodies from a description string. */
function extractAliasTokens(description: string): string[] {
  const tokens: string[] = [];
  // Find "(also called: …)" parentheticals, handling nested parens like "(BI)".
  // Strategy: scan for "(also called:" then consume until the matching outer ")" using
  // a bracket counter so inner parens like "(BI)" don't terminate the match early.
  const marker = '(also called:';
  let pos = 0;
  while (pos < description.length) {
    const start = description.toLowerCase().indexOf(marker, pos);
    if (start === -1) break;
    // Walk forward from start, counting open/close parens to find the matching ")".
    let depth = 0;
    let end = -1;
    for (let i = start; i < description.length; i++) {
      if (description[i] === '(') depth++;
      else if (description[i] === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break; // unclosed paren — stop
    // Extract the body after "also called:" up to the matching ")"
    const body = description.slice(start + marker.length, end);
    // Split on top-level commas only (don't split inside nested parens)
    const parts = splitTopLevel(body);
    for (const p of parts) {
      const norm = p.trim().replace(/\s+/g, ' ').toLowerCase();
      if (norm) tokens.push(norm);
    }
    pos = end + 1;
  }
  return tokens;
}

test('alias-lint: no alias appears in two different family parentheticals', () => {
  // Collect alias → family for every primary tool.
  const aliasToFamily = new Map<string, string>();

  for (const [family, toolNames] of Object.entries(FAMILY_PRIMARY_TOOLS)) {
    for (const toolName of toolNames) {
      const tool = ALL_MCP_TOOLS.find((t) => t.name === toolName);
      if (!tool) continue; // handled separately in assertion B
      const tokens = extractAliasTokens(tool.description);
      for (const token of tokens) {
        if (aliasToFamily.has(token) && aliasToFamily.get(token) !== family) {
          assert.fail(
            `Alias collision: "${token}" appears in both family "${aliasToFamily.get(token)}" and family "${family}" (tool: ${toolName})`,
          );
        }
        aliasToFamily.set(token, family);
      }
    }
  }
});

test("alias-lint: every approved alias appears in its family's primary tool descriptions", () => {
  for (const [family, requiredAliases] of Object.entries(ALIAS_MAP)) {
    const toolNames = FAMILY_PRIMARY_TOOLS[family] ?? [];

    // Gather all alias tokens across ALL primary tools for this family.
    const foundTokens = new Set<string>();
    for (const toolName of toolNames) {
      const tool = ALL_MCP_TOOLS.find((t) => t.name === toolName);
      assert.ok(tool, `Family "${family}": primary tool "${toolName}" not found in ALL_MCP_TOOLS — was it renamed?`);
      for (const token of extractAliasTokens(tool.description)) {
        foundTokens.add(token);
      }
    }

    for (const alias of requiredAliases) {
      const normalised = alias.toLowerCase();
      assert.ok(
        foundTokens.has(normalised),
        `Family "${family}": approved alias "${alias}" not found in any of [${toolNames.join(', ')}]. ` +
          `Found tokens: [${[...foundTokens].join(', ')}]`,
      );
    }
  }
});

test('alias-lint: approved map families all have primary tool entries', () => {
  for (const family of Object.keys(ALIAS_MAP)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(FAMILY_PRIMARY_TOOLS, family),
      `Family "${family}" is in ALIAS_MAP but has no entry in FAMILY_PRIMARY_TOOLS`,
    );
  }
});
