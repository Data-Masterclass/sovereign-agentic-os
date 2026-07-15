/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * REAL cross-tab component reader for the Big Bets picker.
 *
 * This is the consolidation seam promised in `sources.ts`: instead of scanning an
 * empty in-memory Map, the "Link existing" picker reads the ACTUAL artifacts a
 * student built across the tabs — datasets, agents, dashboards, knowledge docs,
 * files and metrics — each through that tab's OWN governed `list(user)` gate, so a
 * viewer only ever sees what they may see (no cross-domain / other-user leak). The
 * mapping to the bet's `Artifact` reference card mirrors `attach_component`
 * (write-tools.ts) exactly: same tier → visibility, same lifecycle tokens.
 *
 * Importing this module registers the reader on `sources.ts` (a side effect), so a
 * route only needs `import '@/lib/bigbets/real-sources'` and then
 * `sourceFor(tab).list({ viewer })`. `sources.ts` itself stays free of these
 * server-side store imports and remains unit-testable.
 */

import type { Artifact, Principal, Tab } from './model.ts';
import { setRealTabReader } from './sources.ts';
import { listDatasets } from '@/lib/data/store';
import { listSystems } from '@/lib/agents/store';
import { listDashboards } from '@/lib/dashboards/store';
import { listWorkflows } from '@/lib/knowledge/store';
import { listFiles } from '@/lib/files/store';
import { listMetrics } from '@/lib/metrics/store';
import { listModelsForUser } from '@/lib/science/model-service';

function card(input: {
  id: string;
  tab: Tab;
  title: string;
  domain: string;
  visibility: Artifact['visibility'];
  lifecycle: Artifact['lifecycle'];
}): Artifact {
  return {
    id: input.id,
    tab: input.tab,
    title: input.title,
    domain: input.domain,
    visibility: input.visibility,
    lifecycle: input.lifecycle,
    consumes: [],
    bigBetIds: [],
    usage30d: 0,
  };
}

/** Medallion/tier maps, matching attach_component's reference-card mapping. */
function medallionVisibility(tier: 'dataset' | 'asset' | 'product'): Artifact['visibility'] {
  return tier === 'product' ? 'marketplace' : tier === 'asset' ? 'shared' : 'personal';
}
function tabVisibility(v: 'Personal' | 'Shared' | 'Marketplace'): Artifact['visibility'] {
  return v === 'Marketplace' ? 'marketplace' : v === 'Shared' ? 'shared' : 'personal';
}

const READERS: Partial<Record<Tab, (viewer: Principal) => Artifact[]>> = {
  data(viewer) {
    const g = listDatasets(viewer);
    return [...g.mine, ...g.domain, ...g.marketplace].map((d) =>
      card({
        id: d.id,
        tab: 'data',
        title: d.name,
        domain: d.domain,
        visibility: medallionVisibility(d.tier),
        // Data's ready verb is `certified` — a promoted asset/product has passed it.
        lifecycle: d.tier !== 'dataset' ? 'certified' : d.dots.bronze || d.dots.silver || d.dots.gold ? 'building' : 'draft',
      }),
    );
  },
  agent(viewer) {
    const g = listSystems(viewer);
    return [...g.mine, ...g.domain, ...g.marketplace].map((s) =>
      card({
        id: s.id,
        tab: 'agent',
        title: s.name,
        domain: s.domain,
        visibility: tabVisibility(s.visibility),
        // Agents' ready verb is `live` — reached only by the governed promote.
        lifecycle: s.visibility === 'Personal' ? 'draft' : 'live',
      }),
    );
  },
  dashboard(viewer) {
    const g = listDashboards(viewer);
    // DashboardSummary has no domain; a personal dashboard is the viewer's own,
    // a domain dashboard is in one of the viewer's domains — tag with that scope.
    const scope = viewer.domains[0] ?? '';
    return [...g.mine, ...g.domain, ...g.marketplace].map((d) =>
      card({
        id: d.id,
        tab: 'dashboard',
        title: d.name,
        domain: scope,
        visibility: d.tier === 'personal' ? 'personal' : d.tier === 'domain' ? 'shared' : 'marketplace',
        lifecycle: d.tier === 'personal' ? 'draft' : 'published',
      }),
    );
  },
  knowledge(viewer) {
    const g = listWorkflows(viewer);
    return [...g.mine, ...g.domain, ...g.marketplace].map((w) =>
      card({
        id: w.id,
        tab: 'knowledge',
        title: w.title,
        domain: w.domain,
        visibility: tabVisibility(w.visibility),
        lifecycle: w.status === 'live' ? 'published' : 'draft',
      }),
    );
  },
  files(viewer) {
    const g = listFiles(viewer);
    return [...g.mine, ...g.domain, ...g.marketplace].map((f) =>
      card({
        id: f.id,
        tab: 'files',
        title: f.name,
        domain: f.domain,
        visibility: medallionVisibility(f.tier),
        lifecycle: f.tier !== 'dataset' ? 'published' : 'draft',
      }),
    );
  },
  metric(viewer) {
    const g = listMetrics(viewer);
    const scope = viewer.domains[0] ?? '';
    return [...g.mine, ...g.domain, ...g.marketplace].map((m) =>
      card({
        id: m.id,
        tab: 'metric',
        title: m.name,
        domain: scope,
        visibility: m.tier === 'personal' ? 'personal' : m.tier === 'domain' ? 'shared' : 'marketplace',
        lifecycle: m.tier === 'personal' ? 'draft' : 'promoted',
      }),
    );
  },
  ml(viewer) {
    // Science models: listModelsForUser is synchronous + RLS-scoped by the model
    // tier ladder (Personal→owner, Domain→domain members, Marketplace→all), the
    // same shape every other reader relies on. Map the tier → reference visibility
    // and the stage → lifecycle (ml's ready verb is `production`).
    const models = listModelsForUser({ id: viewer.id, domains: viewer.domains });
    return models.map((m) =>
      card({
        id: m.id,
        tab: 'ml',
        title: m.name,
        domain: m.domain,
        visibility: m.tier === 'Personal' ? 'personal' : m.tier === 'Domain' ? 'shared' : 'marketplace',
        lifecycle: m.stage === 'Production' ? 'production' : 'staging',
      }),
    );
  },
};

/**
 * Read the REAL artifacts a viewer may see for `tab`, via that tab's own governed
 * list gate. `software` and `connection` are NOT wired here: their governed list
 * gates (`listAppsForUser` / `listConnectionsForUser`) are ASYNC, and this reader
 * seam (`RealTabReader` → `sourceFor(tab).list()`) is synchronous — wiring them
 * cleanly needs the seam made async (a later phase), so they return [] and fall
 * back to the in-memory registry. Defensive: a store error never breaks the picker
 * — it just yields no real artifacts for that tab.
 */
export function listRealArtifacts(tab: Tab, viewer: Principal): Artifact[] {
  const reader = READERS[tab];
  if (!reader) return [];
  try {
    return reader(viewer);
  } catch {
    return [];
  }
}

// Register on import (the server boundary opts in by importing this module).
setRealTabReader(listRealArtifacts);
