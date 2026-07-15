/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The single tutorial registry — keyed by golden path. Both entry points (the
 * Home card "How it works" link and the tab header "Tutorial" link) resolve the
 * SAME `TutorialDef` here, so they can never drift.
 *
 * Content is authored, one file per path in `./content`. This module only
 * assembles them and validates the set at load (every key present exactly once,
 * sandbox walk-throughs provably governed-write-free).
 */

import type { GoldenPathKey, TutorialDef } from './types';
import { assertSandboxSafe, walkSteps } from './engine';

import data from './content/data';
import knowledge from './content/knowledge';
import files from './content/files';
import connections from './content/connections';
import agents from './content/agents';
import software from './content/software';
import science from './content/science';
import metrics from './content/metrics';
import dashboards from './content/dashboards';
import bigBets from './content/big-bets';
import strategy from './content/strategy';
import marketplace from './content/marketplace';
import governance from './content/governance';
import monitoring from './content/monitoring';

const REGISTRY: Record<GoldenPathKey, TutorialDef> = {
  data,
  knowledge,
  files,
  connections,
  agents,
  software,
  science,
  metrics,
  dashboards,
  'big-bets': bigBets,
  strategy,
  marketplace,
  governance,
  monitoring,
};

/** Canonical ordering for galleries (mirrors the Home launcher). */
export const TUTORIAL_ORDER: GoldenPathKey[] = [
  'data',
  'knowledge',
  'files',
  'connections',
  'agents',
  'software',
  'science',
  'metrics',
  'dashboards',
  'big-bets',
  'strategy',
  'marketplace',
  'governance',
  'monitoring',
];

/**
 * Nav tabs that DELIBERATELY have no tutorial — the documented-exclusion list
 * the coverage tripwire (`coverage.test.ts`) checks against. Every canonical OS
 * tab must either have a registry tutorial (matched by route) or an entry here
 * with a reason. Admin-group tabs (Admin, Terminal, About / Licenses — those with
 * minRole='admin') are exempt as a class: they are operator consoles for the
 * admins RUNNING the OS — operators, not students — and are covered by the
 * operator guide, not in-app teaching.
 * If a console ever becomes a student surface, give it a tutorial.
 */
export const TUTORIAL_EXEMPT_ROUTES: Record<string, string> = {
  '/': 'Home is the tutorial launcher itself — it hosts the golden-path gallery.',
  '/cockpit':
    'Read-only personal overview that aggregates the tabs; every card deep-links into a tab that has its own tutorial.',
  '/tutorials':
    'The tutorial gallery itself — teaching how to open tutorials would be circular.',
  '/mcp':
    'Static reference/teaching page that documents the MCP protocol and tool catalog; the connection instructions are self-contained and nothing needs practising in a sandbox.',
  '/llm-gateway':
    'Read-only observability over the LiteLLM gateway (tenant usage + the public Model Hub embed); nothing to configure or practise — the actionable model/cost controls live in Platform.',
  '/workflows':
    'Newly split out of Knowledge (its tutorial still lives under the Knowledge golden path). A dedicated Workflows tutorial ships with the Workflows redesign (Operating Manual + 2-tab detail); exempt until then.',
};

/** Resolve one tutorial. Returns `undefined` for an unknown key. */
export function getTutorial(key: string): TutorialDef | undefined {
  return REGISTRY[key as GoldenPathKey];
}

/** All tutorials in canonical order. */
export function listTutorials(): TutorialDef[] {
  return TUTORIAL_ORDER.map((k) => REGISTRY[k]);
}

export function isGoldenPathKey(key: string): key is GoldenPathKey {
  return key in REGISTRY;
}

// ---- registry self-check (cheap; runs once at import) -----------------------
for (const key of TUTORIAL_ORDER) {
  const def = REGISTRY[key];
  if (!def) throw new Error(`tutorial registry missing "${key}"`);
  if (def.key !== key) {
    throw new Error(`tutorial "${key}" declares mismatched key "${def.key}"`);
  }
  // The "no governed writes in practice" invariant, proven for every tutorial.
  assertSandboxSafe(walkSteps(def, 'sandbox', 'user'));
}
