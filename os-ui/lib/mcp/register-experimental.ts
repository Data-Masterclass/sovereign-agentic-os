/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import type { McpTool } from './server';
import { registerToolBundle } from './registry';
import { TAB_FEATURES } from '@/lib/core/tabs';
import { config } from '@/lib/core/config';

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
 * bigbets' MCP tab is 'bigbets' but its UI feature key is 'big-bets'
 * (hyphenated) — mapped explicitly below. exposure-write-tools mixes
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
  // science_predict, search_knowledge) — extracted but still unconditional.
  { name: 'platform-tools', load: async () => (await import('@/lib/experimental/mcp/platform-tools')).platformTools },
  { name: 'data-query', load: async () => (await import('@/lib/experimental/mcp/data-query-tools')).dataQueryTools },
  { name: 'science-predict', load: async () => (await import('@/lib/experimental/mcp/science-predict-tools')).sciencePredictTools },
  { name: 'knowledge-search', load: async () => (await import('@/lib/experimental/mcp/knowledge-search-tools')).knowledgeSearchTools },
  {
    feature: 'data',
    name: 'data-write',
    load: async () => {
      const [write, promo, exposure, read, waveb] = await Promise.all([
        import('@/lib/experimental/mcp/data-write-tools'),
        import('@/lib/experimental/mcp/promotion-write-tools'),
        import('@/lib/experimental/mcp/exposure-write-tools'),
        import('@/lib/experimental/mcp/discovery-read-tools'),
        import('@/lib/experimental/mcp/discovery-waveb-tools'),
      ]);
      return [
        ...write.dataWriteTools,
        ...promo.promotionTools,
        ...byTab(exposure.exposureWriteTools, 'data'),
        ...byTab(read.readTools, 'data'),
        ...byTab(waveb.waveBReadTools, 'data'),
      ];
    },
    hydrate: () => import('@/lib/experimental/data/store').then((m) => m.ensureHydrated()),
  },
  {
    feature: 'knowledge',
    name: 'knowledge-write',
    load: async () => {
      const [write, read] = await Promise.all([
        import('@/lib/experimental/mcp/knowledge-write-tools'),
        import('@/lib/experimental/mcp/discovery-read-tools'),
      ]);
      return [...write.knowledgeWriteTools, ...byTab(read.readTools, 'knowledge')];
    },
    hydrate: () => import('@/lib/experimental/knowledge/store').then((m) => m.ensureHydrated()),
  },
  {
    feature: 'files',
    name: 'file-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@/lib/experimental/mcp/file-write-tools'),
        import('@/lib/experimental/mcp/discovery-read-tools'),
        import('@/lib/experimental/mcp/discovery-waveb-tools'),
      ]);
      return [...write.fileWriteTools, ...byTab(read.readTools, 'files'), ...byTab(waveb.waveBReadTools, 'files')];
    },
    hydrate: () => import('@/lib/experimental/files/store').then((m) => m.ensureHydrated()),
  },
  {
    feature: 'metrics',
    name: 'metric-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@/lib/experimental/mcp/metric-write-tools'),
        import('@/lib/experimental/mcp/discovery-read-tools'),
        import('@/lib/experimental/mcp/discovery-waveb-tools'),
      ]);
      return [...write.metricWriteTools, ...byTab(read.readTools, 'metrics'), ...byTab(waveb.waveBReadTools, 'metrics')];
    },
  },
  {
    feature: 'dashboards',
    name: 'dashboard-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@/lib/experimental/mcp/dashboard-write-tools'),
        import('@/lib/experimental/mcp/discovery-read-tools'),
        import('@/lib/experimental/mcp/discovery-waveb-tools'),
      ]);
      return [...write.dashboardWriteTools, ...byTab(read.readTools, 'dashboards'), ...byTab(waveb.waveBReadTools, 'dashboards')];
    },
  },
  {
    feature: 'big-bets',
    name: 'bigbet-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@/lib/experimental/mcp/bigbet-write-tools'),
        import('@/lib/experimental/mcp/discovery-read-tools'),
        import('@/lib/experimental/mcp/discovery-waveb-tools'),
      ]);
      return [...write.bigbetWriteTools, ...byTab(read.readTools, 'bigbets'), ...byTab(waveb.waveBReadTools, 'bigbets')];
    },
    hydrate: () => import('@/lib/experimental/bigbets/store').then((m) => m.ensureHydrated()),
  },
  {
    feature: 'software',
    name: 'software-write',
    load: async () => {
      const [write, read, waveb] = await Promise.all([
        import('@/lib/experimental/mcp/software-write-tools'),
        import('@/lib/experimental/mcp/discovery-read-tools'),
        import('@/lib/experimental/mcp/discovery-waveb-tools'),
      ]);
      return [...write.softwareWriteTools, ...byTab(read.readTools, 'software'), ...byTab(waveb.waveBReadTools, 'software')];
    },
  },
  {
    feature: 'science',
    name: 'science-write',
    load: async () => {
      const [write, discover] = await Promise.all([
        import('@/lib/experimental/mcp/science-write-tools'),
        import('@/lib/experimental/mcp/discovery-science-tools'),
      ]);
      return [...write.scienceWriteTools, ...discover.scienceTools];
    },
  },
  {
    feature: 'connections',
    name: 'exposure-write',
    load: async () => {
      const [exposure, conn, airflow, warehouse, om] = await Promise.all([
        import('@/lib/experimental/mcp/exposure-write-tools'),
        import('@/lib/experimental/mcp/discovery-connection-tools'),
        import('@/lib/experimental/mcp/discovery-airflow-tools'),
        import('@/lib/experimental/mcp/discovery-warehouse-tools'),
        import('@/lib/experimental/mcp/discovery-om-tools'),
      ]);
      return [
        // the tab:'data' exposure tools live in the `data` bundle above
        ...exposure.exposureWriteTools.filter((t) => t.tab !== 'data'),
        ...conn.connectionTools,
        ...airflow.airflowTools,
        // Preserves discovery-tools.ts's old operator-config gates: these two
        // surface only when the operator actually enabled that connector.
        ...(config.externalConnectorsEnabled ? warehouse.warehouseTools : []),
        ...(config.openmetadataConnectEnabled ? om.omCatalogTools : []),
      ];
    },
  },
  {
    feature: 'strategy',
    name: 'strategy',
    load: async () => {
      const m = await import('@/lib/experimental/mcp/strategy-tools');
      return [...m.strategyReadTools, ...m.strategyWriteTools];
    },
  },
  {
    feature: 'marketplace',
    name: 'marketplace',
    load: async () => {
      const [m, gov] = await Promise.all([
        import('@/lib/experimental/mcp/marketplace-tools'),
        import('@/lib/mcp/governance-tools'),
      ]);
      return [...m.marketplaceReadTools, ...m.marketplaceWriteTools, ...gov.governanceMarketplaceTools];
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
