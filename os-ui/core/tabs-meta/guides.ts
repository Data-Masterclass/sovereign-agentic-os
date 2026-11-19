/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Golden-path guides — load the guide markdown an AI reads when it connects
 * USER STORY: As an AI client connected over MCP I want a full guide for each pathway (tool order,
 *             things to consider, governance gates) so that I can build without guessing.
 * ARCHITECTURE:
 *   - Server-only. Served as `sovereign-os://guide/*` resources and by the `get_guide` tool
 *     (`tabs/admin/mcp/resources.ts`, `core/mcp/discovery-base-tools.ts`, `core/mcp/prompts.ts`).
 *   - A tab's guide is `tabs/<tab>/guide.md`; overview, how-to-use and governance live in
 *     `core/guides/<name>.guide.md`. Read once and cached; a missing file returns ''.
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The stable guide keys ("paths"). Two meta guides + one per golden pathway. */
export const GUIDE_PATHS = [
  'how-to-use',
  'overview',
  'governance',
  'data',
  'knowledge',
  'connections',
  'agents',
  'software',
  'metrics',
  'dashboards',
  'files',
  'monitoring',
] as const;
export type GuidePath = (typeof GUIDE_PATHS)[number];

export function isGuidePath(x: string): x is GuidePath {
  return (GUIDE_PATHS as readonly string[]).includes(x);
}

// A tab's guide lives with the tab (tabs/<tab>/guide.md); the cross-cutting ones
// (overview, how-to-use, governance) live in core/guides/<name>.guide.md.
const ROOT = process.cwd();
const CORE_GUIDES = new Set(['overview', 'how-to-use', 'governance']);
const guideFile = (path: string) =>
  CORE_GUIDES.has(path)
    ? join(ROOT, 'core', 'guides', `${path}.guide.md`)
    : join(ROOT, 'tabs', path.replace(/^path\//, ''), 'guide.md');
const cache = new Map<GuidePath, string>();

/** The markdown for a guide (cached). Unknown/missing → '' . */
export function loadGuide(path: GuidePath): string {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  let text = '';
  try {
    text = readFileSync(guideFile(path), 'utf8').trim();
  } catch {
    text = '';
  }
  cache.set(path, text);
  return text;
}

const TITLES: Record<GuidePath, string> = {
  'how-to-use': 'How to use this MCP',
  overview: 'OS Overview',
  governance: 'Governance & Roles',
  data: 'Data — golden path',
  knowledge: 'Knowledge — golden path',
  connections: 'Connections — golden path',
  agents: 'Agents — golden path',
  software: 'Software — golden path',
  metrics: 'Metrics — golden path',
  dashboards: 'Dashboards — golden path',
  files: 'Files — golden path',
  monitoring: 'Monitoring — golden path',

};
export function guideTitle(path: GuidePath): string {
  return TITLES[path];
}
