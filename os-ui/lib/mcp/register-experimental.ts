/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import type { McpTool } from './server';
import { registerToolBundle } from './registry';
import { TAB_FEATURES } from '@/lib/core/tabs';
import { config } from '@/lib/core/config';

/**
 * Non-base bundles — self-register only when their tab's feature flag is on,
 * via dynamic import() so Next.js can code-split them out of the base build.
 *
 * Top-level await: server.ts does `import '@/lib/mcp/register-experimental'`
 * before it computes ALL_MCP_TOOLS. Per the ES module spec, an importer of a
 * module with top-level await doesn't resume until that module (and this
 * Promise.all) settles — so every registration below is guaranteed done
 * before ALL_MCP_TOOLS runs, with no separate async wiring needed.
 *
 * bigbets' MCP tab is 'bigbets' but its UI feature key is 'big-bets'
 * (hyphenated) — mapped explicitly below. exposure-write-tools mixes
 * tab:'connections' (10 tools) and tab:'data' (2) in one file; gated under
 * 'connections' (the majority) for now.
 *
 * discovery-read-tools.ts and discovery-waveb-tools.ts each mix several
 * domains in one file/array (their old home, discovery-tools.ts, was itself
 * a god-module) — filtered by `tab` per domain and merged into that domain's
 * bundle below, alongside its write tools.
 */
async function registerIfEnabled(
  feature: string,
  name: string,
  load: () => Promise<McpTool[]>,
  hydrate?: () => Promise<void>,
): Promise<void> {
  if (!TAB_FEATURES.has(feature)) return;
  registerToolBundle({ name, tools: await load(), hydrate });
}

const byTab = (tools: McpTool[], tab: string) => tools.filter((t) => t.tab === tab);

/**
 * #28 step 1: server.ts's inline tools (platform, query_data, science_predict,
 * search_knowledge), extracted but still unconditional — same behavior as
 * before, just out of server.ts. Real flag-gating is a follow-up step.
 */
async function registerAlways(name: string, load: () => Promise<McpTool[]>): Promise<void> {
  registerToolBundle({ name, tools: await load() });
}

await Promise.all([
  registerAlways('platform-tools', async () => (await import('@/lib/experimental/mcp/platform-tools')).platformTools),
  registerAlways('data-query', async () => (await import('@/lib/experimental/mcp/data-query-tools')).dataQueryTools),
  registerAlways('science-predict', async () => (await import('@/lib/experimental/mcp/science-predict-tools')).sciencePredictTools),
  registerAlways('knowledge-search', async () => (await import('@/lib/experimental/mcp/knowledge-search-tools')).knowledgeSearchTools),
]);

await Promise.all([
  registerIfEnabled('data', 'data-write', async () => {
    const [write, promo, read, waveb] = await Promise.all([
      import('@/lib/experimental/mcp/data-write-tools'),
      import('@/lib/experimental/mcp/promotion-write-tools'),
      import('@/lib/experimental/mcp/discovery-read-tools'),
      import('@/lib/experimental/mcp/discovery-waveb-tools'),
    ]);
    return [...write.dataWriteTools, ...promo.promotionTools, ...byTab(read.readTools, 'data'), ...byTab(waveb.waveBReadTools, 'data')];
  }, () => import('@/lib/experimental/data/store').then((m) => m.ensureHydrated())),
  registerIfEnabled('knowledge', 'knowledge-write', async () => {
    const [write, read] = await Promise.all([
      import('@/lib/experimental/mcp/knowledge-write-tools'),
      import('@/lib/experimental/mcp/discovery-read-tools'),
    ]);
    return [...write.knowledgeWriteTools, ...byTab(read.readTools, 'knowledge')];
  }, () => import('@/lib/experimental/knowledge/store').then((m) => m.ensureHydrated())),
  registerIfEnabled('files', 'file-write', async () => {
    const [write, read, waveb] = await Promise.all([
      import('@/lib/experimental/mcp/file-write-tools'),
      import('@/lib/experimental/mcp/discovery-read-tools'),
      import('@/lib/experimental/mcp/discovery-waveb-tools'),
    ]);
    return [...write.fileWriteTools, ...byTab(read.readTools, 'files'), ...byTab(waveb.waveBReadTools, 'files')];
  }, () => import('@/lib/experimental/files/store').then((m) => m.ensureHydrated())),
  registerIfEnabled('metrics', 'metric-write', async () => {
    const [write, read, waveb] = await Promise.all([
      import('@/lib/experimental/mcp/metric-write-tools'),
      import('@/lib/experimental/mcp/discovery-read-tools'),
      import('@/lib/experimental/mcp/discovery-waveb-tools'),
    ]);
    return [...write.metricWriteTools, ...byTab(read.readTools, 'metrics'), ...byTab(waveb.waveBReadTools, 'metrics')];
  }),
  registerIfEnabled('dashboards', 'dashboard-write', async () => {
    const [write, read, waveb] = await Promise.all([
      import('@/lib/experimental/mcp/dashboard-write-tools'),
      import('@/lib/experimental/mcp/discovery-read-tools'),
      import('@/lib/experimental/mcp/discovery-waveb-tools'),
    ]);
    return [...write.dashboardWriteTools, ...byTab(read.readTools, 'dashboards'), ...byTab(waveb.waveBReadTools, 'dashboards')];
  }),
  registerIfEnabled('big-bets', 'bigbet-write', async () => {
    const [write, read, waveb] = await Promise.all([
      import('@/lib/experimental/mcp/bigbet-write-tools'),
      import('@/lib/experimental/mcp/discovery-read-tools'),
      import('@/lib/experimental/mcp/discovery-waveb-tools'),
    ]);
    return [...write.bigbetWriteTools, ...byTab(read.readTools, 'bigbets'), ...byTab(waveb.waveBReadTools, 'bigbets')];
  }, () => import('@/lib/experimental/bigbets/store').then((m) => m.ensureHydrated())),
  registerIfEnabled('software', 'software-write', async () => {
    const [write, read, waveb] = await Promise.all([
      import('@/lib/experimental/mcp/software-write-tools'),
      import('@/lib/experimental/mcp/discovery-read-tools'),
      import('@/lib/experimental/mcp/discovery-waveb-tools'),
    ]);
    return [...write.softwareWriteTools, ...byTab(read.readTools, 'software'), ...byTab(waveb.waveBReadTools, 'software')];
  }),
  registerIfEnabled('science', 'science-write', async () => {
    const [write, discover] = await Promise.all([
      import('@/lib/experimental/mcp/science-write-tools'),
      import('@/lib/experimental/mcp/discovery-science-tools'),
    ]);
    return [...write.scienceWriteTools, ...discover.scienceTools];
  }),
  registerIfEnabled('connections', 'exposure-write', async () => {
    const [exposure, conn, airflow, warehouse, om] = await Promise.all([
      import('@/lib/experimental/mcp/exposure-write-tools'),
      import('@/lib/experimental/mcp/discovery-connection-tools'),
      import('@/lib/experimental/mcp/discovery-airflow-tools'),
      import('@/lib/experimental/mcp/discovery-warehouse-tools'),
      import('@/lib/experimental/mcp/discovery-om-tools'),
    ]);
    return [
      ...exposure.exposureWriteTools,
      ...conn.connectionTools,
      ...airflow.airflowTools,
      // Preserves discovery-tools.ts's old operator-config gates: these two
      // surface only when the operator actually enabled that connector.
      ...(config.externalConnectorsEnabled ? warehouse.warehouseTools : []),
      ...(config.openmetadataConnectEnabled ? om.omCatalogTools : []),
    ];
  }),
  registerIfEnabled('strategy', 'strategy', async () => {
    const m = await import('@/lib/experimental/mcp/strategy-tools');
    return [...m.strategyReadTools, ...m.strategyWriteTools];
  }),
  registerIfEnabled('marketplace', 'marketplace', async () => {
    const [m, gov] = await Promise.all([
      import('@/lib/experimental/mcp/marketplace-tools'),
      import('@/lib/mcp/governance-tools'),
    ]);
    return [...m.marketplaceReadTools, ...m.marketplaceWriteTools, ...gov.governanceMarketplaceTools];
  }),
]);
