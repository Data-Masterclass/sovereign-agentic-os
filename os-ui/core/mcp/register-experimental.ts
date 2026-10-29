/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { registerToolBundle } from '@core/mcp/registry';
import { TAB_FEATURES } from '@core/kernel/tabs';
import { config } from '@core/kernel/config';

/**
 * Non-base bundles — registered only when their tab's feature flag is on, via
 * dynamic import() so Next.js can code-split them.
 *
 * ORDERING: every enabled bundle is LOADED in parallel, but REGISTERED
 * sequentially in the order of BUNDLES below — so tool order never depends on
 * which dynamic import resolves first. Order-sensitive consumers
 * (grantedToolSpecs, list_capabilities) therefore see a stable sequence.
 *
 * TIMING: `experimentalRegistered` is a single memoized promise. server.ts awaits
 * it (the top-level await at the bottom of this module) before it computes
 * ALL_MCP_TOOLS; anything else that needs the registry complete can await it
 * explicitly instead of relying on import order. Registration is a one-time
 * decision per process — changing OS_ENABLED_TABS needs a restart.
 *
 * exposure-write-tools mixes
 * tab:'connections' and tab:'data' in one file: each tool goes to the bundle of
 * its own tab, so enabling `data` without `connections` still exposes the
 * data-tab exposure tools.
 *
 * discovery-read-tools.ts and discovery-waveb-tools.ts each mix several
 * domains in one file/array (their old home, discovery-tools.ts, was itself
 * a god-module) — filtered by `tab` per domain and merged into that domain's
 * bundle below, alongside its write tools.
 */
type BundleSpec = {
  /** TAB_FEATURES key gating this bundle; undefined = always on (#57 gap 1). */
  feature?: string;
  name: string;
  load: () => Promise<McpTool[]>;
  hydrate?: () => Promise<void>;
};

const byTab = (tools: McpTool[], tab: string) => tools.filter((t) => t.tab === tab);

const BUNDLES: BundleSpec[] = [
  // #28 step 1: server.ts's former inline tools (platform, query_data,
  // search_knowledge) — extracted but still unconditional.
  { name: 'platform-tools', load: async () => (await import('@core/mcp/experimental/platform-tools')).platformTools },
  { name: 'data-query', load: async () => (await import('@tabs/data/mcp/data-query-tools')).dataQueryTools },
  { name: 'knowledge-search', load: async () => (await import('@tabs/knowledge/mcp/knowledge-search-tools')).knowledgeSearchTools },
  {
    feature: 'data',
    name: 'data-write',
    load: async () => {
      const [write, promo, exposure, read, waveb] = await Promise.all([
        import('@core/mcp/experimental/data-write-tools'),
        import('@core/mcp/experimental/promotion-write-tools'),
        import('@core/mcp/experimental/exposure-write-tools'),
        import('@tabs/admin/mcp/discovery-read-tools'),
        import('@tabs/admin/mcp/discovery-waveb-tools'),
      ]);
      return [
        ...write.dataWriteTools,
        ...promo.promotionTools,
        ...byTab(exposure.exposureWriteTools, 'data'),
        ...byTab(read.readTools, 'data'),
        ...byTab(waveb.waveBReadTools, 'data'),
      ];
    },
    hydrate: () => import('@tabs/data/lib/store').then((m) => m.ensureHydrated()),
  },
  {
    feature: 'knowledge',
    name: 'knowledge-write',
    load: async () => {
      const [write, read] = await Promise.all([
        import('@tabs/knowledge/mcp/knowledge-write-tools'),
        import('@tabs/admin/mcp/discovery-read-tools'),
      ]);
      return [...write.knowledgeWriteTools, ...byTab(read.readTools, 'knowledge')];
    },
    hydrate: () => import('@tabs/knowledge/lib/store').then((m) => m.ensureHydrated()),
  },
  {
    feature: 'files',
    name: 'file-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@tabs/files/mcp/file-write-tools'),
        import('@tabs/admin/mcp/discovery-read-tools'),
        import('@tabs/admin/mcp/discovery-waveb-tools'),
      ]);
      return [...write.fileWriteTools, ...byTab(read.readTools, 'files'), ...byTab(waveb.waveBReadTools, 'files')];
    },
    hydrate: () => import('@tabs/files/lib/store').then((m) => m.ensureHydrated()),
  },
  {
    feature: 'metrics',
    name: 'metric-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@tabs/metrics/mcp/metric-write-tools'),
        import('@tabs/admin/mcp/discovery-read-tools'),
        import('@tabs/admin/mcp/discovery-waveb-tools'),
      ]);
      return [...write.metricWriteTools, ...byTab(read.readTools, 'metrics'), ...byTab(waveb.waveBReadTools, 'metrics')];
    },
  },
  {
    feature: 'dashboards',
    name: 'dashboard-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@tabs/dashboards/mcp/dashboard-write-tools'),
        import('@tabs/admin/mcp/discovery-read-tools'),
        import('@tabs/admin/mcp/discovery-waveb-tools'),
      ]);
      return [...write.dashboardWriteTools, ...byTab(read.readTools, 'dashboards'), ...byTab(waveb.waveBReadTools, 'dashboards')];
    },
  },

  {
    feature: 'software',
    name: 'software-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@tabs/software/mcp/software-write-tools'),
        import('@tabs/admin/mcp/discovery-read-tools'),
        import('@tabs/admin/mcp/discovery-waveb-tools'),
      ]);
      return [...write.softwareWriteTools, ...byTab(read.readTools, 'software'), ...byTab(waveb.waveBReadTools, 'software')];
    },
  },

  {
    feature: 'connections',
    name: 'exposure-write',
    load: async () => {
      const [exposure, conn] = await Promise.all([
        import('@core/mcp/experimental/exposure-write-tools'),
        import('@tabs/connections/mcp/discovery-connection-tools'),
      ]);
      return [
        // the tab:'data' exposure tools live in the `data` bundle above
        ...exposure.exposureWriteTools.filter((t) => t.tab !== 'data'),
        ...conn.connectionTools,
      ];
    },
  },

];

/**
 * Load every enabled bundle in parallel, then register them in BUNDLES order.
 * Exported (and parameterised on the flag check) so the gating itself is
 * testable; the default call below uses the real TAB_FEATURES.
 */
export async function registerExperimentalBundles(
  isEnabled: (feature: string) => boolean = (f) => TAB_FEATURES.has(f),
  specs: BundleSpec[] = BUNDLES,
): Promise<void> {
  const enabled = specs.filter((s) => !s.feature || isEnabled(s.feature));
  const loaded = await Promise.all(enabled.map((s) => s.load()));
  enabled.forEach((s, i) => registerToolBundle({ name: s.name, tools: loaded[i], hydrate: s.hydrate }));
}

/** Memoized — the registry is filled exactly once per process. */
export const experimentalRegistered: Promise<void> = registerExperimentalBundles();

// server.ts imports this module for its side effect and must not resume until
// registration is complete (top-level await per the ES module spec).
await experimentalRegistered;
