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
import connections from './content/connections';
import agents from './content/agents';
import software from './content/software';
import science from './content/science';
import metrics from './content/metrics';
import dashboards from './content/dashboards';
import bigBets from './content/big-bets';
import marketplace from './content/marketplace';

const REGISTRY: Record<GoldenPathKey, TutorialDef> = {
  data,
  knowledge,
  connections,
  agents,
  software,
  science,
  metrics,
  dashboards,
  'big-bets': bigBets,
  marketplace,
};

/** Canonical ordering for galleries (mirrors the Home launcher). */
export const TUTORIAL_ORDER: GoldenPathKey[] = [
  'data',
  'knowledge',
  'connections',
  'agents',
  'software',
  'science',
  'metrics',
  'dashboards',
  'big-bets',
  'marketplace',
];

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
