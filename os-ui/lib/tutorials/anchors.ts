/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The stable UI-anchor contract.
 *
 * The walk-through coach-marks target the REAL tabs' UI via stable
 * `data-tutorial-anchor` attributes. This file is the single contract both sides
 * agree on: tutorials reference these ids; tabs expose them. Ids are namespaced
 * `${path}.${name}` and must stay stable across refactors (rename here + in the
 * tab together). The id convention is enforced at module load (see assertions).
 *
 * Coverage note (kind): for the gate we wire the Data and Agents tabs fully and
 * stub the rest. The engine degrades gracefully when an anchor is absent (it
 * shows a "open this tab to follow along" fallback rather than crashing), so the
 * remaining eight reconcile cleanly at consolidation without engine changes.
 */

/** The HTML attribute name carrying a tutorial anchor id. */
export const ANCHOR_ATTR = 'data-tutorial-anchor';

/**
 * Spread onto any element to expose it as a stable walk-through target:
 *   <button {...anchorAttr(ANCHORS.data.load)}>Load</button>
 */
export function anchorAttr(id: string): { [ANCHOR_ATTR]: string } {
  return { [ANCHOR_ATTR]: id };
}

/** CSS selector for an anchor id (used by the coach-mark engine to locate it). */
export function anchorSelector(id: string): string {
  // Escape double-quotes defensively; ids are controlled but be safe.
  return `[${ANCHOR_ATTR}="${id.replace(/"/g, '\\"')}"]`;
}

/**
 * The contract. Each path declares the anchors its tutorial points at. `sandbox`
 * is the anchor that opens that tab's personal/sandbox lane (practice target).
 */
export const ANCHORS = {
  data: {
    sandbox: 'data.sandbox',
    load: 'data.load',
    clean: 'data.clean',
    document: 'data.document',
    publish: 'data.publish',
    query: 'data.query',
  },
  knowledge: {
    sandbox: 'knowledge.sandbox',
    add: 'knowledge.add',
    organize: 'knowledge.organize',
    publish: 'knowledge.publish',
  },
  files: {
    sandbox: 'files.sandbox',
    upload: 'files.upload',
    search: 'files.search',
    share: 'files.share',
  },
  connections: {
    sandbox: 'connections.sandbox',
    add: 'connections.add',
    configure: 'connections.configure',
    test: 'connections.test',
    govern: 'connections.govern',
  },
  agents: {
    sandbox: 'agents.sandbox',
    define: 'agents.define',
    tools: 'agents.tools',
    run: 'agents.run',
    publish: 'agents.publish',
  },
  software: {
    sandbox: 'software.sandbox',
    describe: 'software.describe',
    build: 'software.build',
    run: 'software.run',
    deploy: 'software.deploy',
  },
  science: {
    sandbox: 'science.sandbox',
    features: 'science.features',
    train: 'science.train',
    register: 'science.register',
    deploy: 'science.deploy',
  },
  metrics: {
    sandbox: 'metrics.sandbox',
    define: 'metrics.define',
    preview: 'metrics.preview',
    publish: 'metrics.publish',
  },
  dashboards: {
    sandbox: 'dashboards.sandbox',
    pick: 'dashboards.pick',
    compose: 'dashboards.compose',
    share: 'dashboards.share',
  },
  'big-bets': {
    sandbox: 'big-bets.sandbox',
    define: 'big-bets.define',
    bundle: 'big-bets.bundle',
    track: 'big-bets.track',
  },
  strategy: {
    sandbox: 'strategy.sandbox',
    rollup: 'strategy.rollup',
    bets: 'strategy.bets',
    value: 'strategy.value',
    create: 'strategy.create',
  },
  marketplace: {
    sandbox: 'marketplace.sandbox',
    browse: 'marketplace.browse',
    inspect: 'marketplace.inspect',
    request: 'marketplace.request',
  },
  governance: {
    sandbox: 'governance.sandbox',
    approve: 'governance.approve',
    remember: 'governance.remember',
    audit: 'governance.audit',
    cost: 'governance.cost',
  },
  monitoring: {
    sandbox: 'monitoring.sandbox',
    scope: 'monitoring.scope',
    attention: 'monitoring.attention',
    lenses: 'monitoring.lenses',
  },
} as const;

/** Flat set of every declared anchor id (for validation + tooling). */
export const ALL_ANCHOR_IDS: string[] = Object.values(ANCHORS).flatMap((group) =>
  Object.values(group),
);

// ---- contract self-check (cheap; runs once at import) -----------------------
for (const id of ALL_ANCHOR_IDS) {
  if (!/^[a-z-]+\.[a-z-]+$/.test(id)) {
    throw new Error(`tutorial anchor id must be "path.name": got "${id}"`);
  }
}
if (new Set(ALL_ANCHOR_IDS).size !== ALL_ANCHOR_IDS.length) {
  throw new Error('duplicate tutorial anchor id in the contract');
}
