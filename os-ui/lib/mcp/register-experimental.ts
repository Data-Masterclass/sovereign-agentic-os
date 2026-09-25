/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import type { McpTool } from './server';
import { registerToolBundle } from './registry';
import { TAB_FEATURES } from '@/lib/core/tabs';

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
 */
async function registerIfEnabled(feature: string, name: string, load: () => Promise<McpTool[]>): Promise<void> {
  if (!TAB_FEATURES.has(feature)) return;
  registerToolBundle({ name, tools: await load() });
}

await Promise.all([
  registerIfEnabled('data', 'data-write', async () => (await import('@/lib/experimental/mcp/data-write-tools')).dataWriteTools),
  registerIfEnabled('data', 'promotion', async () => (await import('@/lib/experimental/mcp/promotion-write-tools')).promotionTools),
  registerIfEnabled('knowledge', 'knowledge-write', async () => (await import('@/lib/experimental/mcp/knowledge-write-tools')).knowledgeWriteTools),
  registerIfEnabled('files', 'file-write', async () => (await import('@/lib/experimental/mcp/file-write-tools')).fileWriteTools),
  registerIfEnabled('metrics', 'metric-write', async () => (await import('@/lib/experimental/mcp/metric-write-tools')).metricWriteTools),
  registerIfEnabled('dashboards', 'dashboard-write', async () => (await import('@/lib/experimental/mcp/dashboard-write-tools')).dashboardWriteTools),
  registerIfEnabled('big-bets', 'bigbet-write', async () => (await import('@/lib/experimental/mcp/bigbet-write-tools')).bigbetWriteTools),
  registerIfEnabled('software', 'software-write', async () => (await import('@/lib/experimental/mcp/software-write-tools')).softwareWriteTools),
  registerIfEnabled('science', 'science-write', async () => (await import('@/lib/experimental/mcp/science-write-tools')).scienceWriteTools),
  registerIfEnabled('connections', 'exposure-write', async () => (await import('@/lib/experimental/mcp/exposure-write-tools')).exposureWriteTools),
  registerIfEnabled('strategy', 'strategy', async () => {
    const m = await import('@/lib/experimental/mcp/strategy-tools');
    return [...m.strategyReadTools, ...m.strategyWriteTools];
  }),
  registerIfEnabled('marketplace', 'marketplace', async () => {
    const m = await import('@/lib/experimental/mcp/marketplace-tools');
    return [...m.marketplaceReadTools, ...m.marketplaceWriteTools];
  }),
]);
