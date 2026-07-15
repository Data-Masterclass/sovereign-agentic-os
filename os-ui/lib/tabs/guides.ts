/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The 12 golden-path GUIDES — the rich, self-describing docs an AI reads on
 * connect (as `sovereign-os://guide/*` resources and via the `get_guide` tool).
 * Each lives in `lib/tabs/guides/<path>.guide.md`. Unlike the token-minimal
 * `*.context.md` briefs, a guide teaches the full pathway: what it is · the exact
 * tool sequence · what to consider · the governance gates. Read once + cached; a
 * missing file degrades to '' (the surface still works, just ungrounded).
 */

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
  'bigbets',
  'files',
  'science',
  'strategy',
  'marketplace',
  'monitoring',
] as const;
export type GuidePath = (typeof GUIDE_PATHS)[number];

export function isGuidePath(x: string): x is GuidePath {
  return (GUIDE_PATHS as readonly string[]).includes(x);
}

const DIR = join(process.cwd(), 'lib', 'tabs', 'guides');
const cache = new Map<GuidePath, string>();

/** The markdown for a guide (cached). Unknown/missing → '' . */
export function loadGuide(path: GuidePath): string {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  let text = '';
  try {
    text = readFileSync(join(DIR, `${path}.guide.md`), 'utf8').trim();
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
  bigbets: 'Big Bets — golden path',
  files: 'Files — golden path',
  science: 'Science — golden path',
  strategy: 'Strategy — golden path',
  marketplace: 'Marketplace — golden path',
  monitoring: 'Monitoring — golden path',
};
export function guideTitle(path: GuidePath): string {
  return TITLES[path];
}
