/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpTab } from '@/lib/mcp/server';

/**
 * Per-tab CONTEXT.md loader. Each `lib/tabs/<tab>.context.md` is a TOKEN-MINIMAL
 * brief (purpose · tools · golden path · constraints) fed to agents building in
 * that tab: it is served as the per-tab MCP `initialize.instructions` and appended
 * to the in-app helper's system prompt. Read once from disk and cached; a missing
 * file degrades to an empty string (the chat/MCP still works, just ungrounded).
 */

const DIR = join(process.cwd(), 'lib', 'tabs');
const cache = new Map<McpTab, string>();

export function loadTabContext(tab: McpTab): string {
  const hit = cache.get(tab);
  if (hit !== undefined) return hit;
  let text = '';
  try {
    text = readFileSync(join(DIR, `${tab}.context.md`), 'utf8').trim();
  } catch {
    text = '';
  }
  cache.set(tab, text);
  return text;
}

const TITLES: Record<McpTab, string> = {
  software: 'Software',
  data: 'Data',
  science: 'Science',
  knowledge: 'Knowledge',
  agents: 'Agents',
  files: 'Files',
  metrics: 'Metrics',
  dashboards: 'Dashboards',
  bigbets: 'Big Bets',
  connections: 'Connections',
  governance: 'Governance',
  marketplace: 'Marketplace',
  strategy: 'Strategy',
  monitoring: 'Monitoring',
  'operating-manual': 'Operating Manual',
};
export function tabTitle(tab: McpTab): string {
  return TITLES[tab];
}

/** Maps an in-app agent-chat `agent` key → the tab whose CONTEXT.md grounds it. */
const AGENT_KEY_TAB: Record<string, McpTab> = {
  'agent-builder': 'agents',
  'software-builder': 'software',
  'software-app': 'software',
  'data-product': 'data',
  knowledge: 'knowledge',
};

/** The CONTEXT.md for an agent-chat key, or '' if that key has no tab context. */
export function contextForAgentKey(agent: string): string {
  const tab = AGENT_KEY_TAB[agent];
  return tab ? loadTabContext(tab) : '';
}

/** The MCP tab an agent-chat key maps to (so its helper can ACT via that tab's
 * tools through the agentic harness), or null when the key has no tool surface. */
export function tabForAgentKey(agent: string): McpTab | null {
  return AGENT_KEY_TAB[agent] ?? null;
}
