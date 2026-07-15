/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session';
import type { ToolTab, McpTab } from './server';

// --- Governed read/list lib functions (the SAME the UI + discovery tools call) --
import { listDatasets, getDataset } from '@/lib/data/store';
import { listWorkflows, getWorkflow, getManual } from '@/lib/knowledge/store';
import { listFiles, getFile } from '@/lib/files/store';
import { listMetrics } from '@/lib/metrics/store';
import { listDashboards, getDashboard } from '@/lib/dashboards/store';
import { listBets, getBet } from '@/lib/bigbets/store';
import { listSystems, getSystem } from '@/lib/agents/store';
import { listAppsForUser, getAppForUser } from '@/lib/software/apps';
import { listConnectionsForUser, getConnectionForUser } from '@/lib/connections';
import { listModelsForUser } from '@/lib/science/model-service';
import { listPillars } from '@/lib/strategy/pillars';
import { config } from '@/lib/core/config';
import { loadGuide, guideTitle, type GuidePath } from '@/lib/tabs/guides';
import { loadBuildSpec } from '@/lib/tabs/build-spec';

/**
 * MCP RESOURCES — application-driven, URI-addressed data an AI READS (vs tools it
 * calls). Three kinds:
 *   • STATIC guides   sovereign-os://guide/*   — the golden-path how-tos (markdown).
 *   • DYNAMIC "my/*"  sovereign-os://my/*       — the caller's OWN inventory (JSON),
 *       produced by the SAME governed store fn the UI calls, so DLS/role scoping is
 *       inherited — a resource NEVER re-implements authz.
 *   • TEMPLATES       sovereign-os://<type>/{id} — one governed record by id.
 * Every read delegates to a governed fn under the caller's identity; an id the
 * caller cannot see throws 404 → surfaced as JSON-RPC -32002 (no existence leak).
 * The `minRole` floor is re-checked on `resources/read` exactly like `tools/call`.
 */

export type McpResource = {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: 'text/markdown' | 'application/json';
  tab: ToolTab;
  minRole: Role;
  /** Annotation hint (overview/governance = 1.0). */
  priority?: number;
  read: (user: CurrentUser) => Promise<string>;
};

export type McpResourceTemplate = {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: 'application/json';
  tab: ToolTab;
  minRole: Role;
  read: (user: CurrentUser, params: Record<string, string>) => Promise<string>;
};

type Principal = { id: string; domains: string[]; role: Role };
const P = (u: CurrentUser): Principal => ({ id: u.id, domains: u.domains, role: u.role });
const json = (v: unknown): string => JSON.stringify(v, null, 2);

// ================================ GUIDES ======================================
type GuideDef = { uri: string; path: GuidePath; tab: ToolTab; priority?: number };
const GUIDE_DEFS: GuideDef[] = [
  { uri: 'sovereign-os://guide/how-to-use', path: 'how-to-use', tab: 'meta', priority: 1 },
  { uri: 'sovereign-os://guide/overview', path: 'overview', tab: 'meta', priority: 1 },
  { uri: 'sovereign-os://guide/governance', path: 'governance', tab: 'meta', priority: 1 },
  { uri: 'sovereign-os://guide/path/data', path: 'data', tab: 'data' },
  { uri: 'sovereign-os://guide/path/knowledge', path: 'knowledge', tab: 'knowledge' },
  { uri: 'sovereign-os://guide/path/connections', path: 'connections', tab: 'connections' },
  { uri: 'sovereign-os://guide/path/agents', path: 'agents', tab: 'agents' },
  { uri: 'sovereign-os://guide/path/software', path: 'software', tab: 'software' },
  { uri: 'sovereign-os://guide/path/metrics', path: 'metrics', tab: 'metrics' },
  { uri: 'sovereign-os://guide/path/dashboards', path: 'dashboards', tab: 'dashboards' },
  { uri: 'sovereign-os://guide/path/bigbets', path: 'bigbets', tab: 'bigbets' },
  { uri: 'sovereign-os://guide/path/files', path: 'files', tab: 'files' },
  { uri: 'sovereign-os://guide/path/science', path: 'science', tab: 'science' },
  { uri: 'sovereign-os://guide/path/strategy', path: 'strategy', tab: 'strategy' },
  { uri: 'sovereign-os://guide/path/marketplace', path: 'marketplace', tab: 'marketplace' },
  { uri: 'sovereign-os://guide/path/monitoring', path: 'monitoring', tab: 'monitoring' },
];

const guideResources: McpResource[] = GUIDE_DEFS.map((g) => ({
  uri: g.uri,
  name: g.path,
  title: guideTitle(g.path),
  description: `Golden-path guide: ${guideTitle(g.path)}. How-to tool sequence · what to consider · governance.`,
  mimeType: 'text/markdown',
  tab: g.tab,
  minRole: 'creator',
  priority: g.priority,
  read: async () => loadGuide(g.path),
}));

/**
 * The canonical BUILD SPEC (Software) — the exact template tree, tool sequence,
 * governance rules, elicitation question set and pre-deploy checklist the
 * Software Delivery Team builds against. Byte-identical to the copy injected into
 * the internal team executor's preamble (asserted by a drift test), so Claude and
 * the internal team follow ONE spec. Referenced from the `build_and_ship_software`
 * prompt. Contains zero secrets — tool names, conventions and examples only.
 */
const buildSpecResource: McpResource = {
  uri: 'sovereign-os://guide/build-spec/software',
  name: 'build-spec-software',
  title: 'Build spec — Software (canonical)',
  description:
    'The canonical Software build spec: the nextjs-supabase template tree + conventions, the governed tool sequence, governance rules, the elicitation question set, and the pre-deploy checklist.',
  mimeType: 'text/markdown',
  tab: 'software',
  minRole: 'creator',
  priority: 1,
  read: async () => loadBuildSpec(),
};

// ============================ DYNAMIC "my/*" ==================================
const myResources: McpResource[] = [
  {
    uri: 'sovereign-os://my/identity',
    name: 'my-identity',
    title: 'My identity',
    description: 'Your delegated identity (id, name, role, domains) — every tool runs AS you.',
    mimeType: 'application/json',
    tab: 'meta',
    minRole: 'creator',
    priority: 0.9,
    read: async (user) => json({ id: user.id, name: user.name, role: user.role, domains: user.domains }),
  },
  {
    uri: 'sovereign-os://my/datasets',
    name: 'my-datasets',
    title: 'My datasets',
    description: 'Datasets you can see (yours · domain · marketplace), DLS-scoped. Reuse before you create.',
    mimeType: 'application/json',
    tab: 'data',
    minRole: 'creator',
    read: async (user) => json(listDatasets(P(user))),
  },
  {
    uri: 'sovereign-os://my/knowledge',
    name: 'my-knowledge',
    title: 'My knowledge',
    description: 'Knowledge workflows you can see, DLS-scoped. Search/reuse before authoring.',
    mimeType: 'application/json',
    tab: 'knowledge',
    minRole: 'creator',
    read: async (user) => json(listWorkflows(P(user))),
  },
  {
    uri: 'sovereign-os://my/connections',
    name: 'my-connections',
    title: 'My connections',
    description: 'Data-source connections you can see (never the raw credential). Reuse before creating.',
    mimeType: 'application/json',
    tab: 'connections',
    minRole: 'creator',
    read: async (user) => json(await listConnectionsForUser(user)),
  },
  {
    uri: 'sovereign-os://my/files',
    name: 'my-files',
    title: 'My files',
    description: 'Files you can see (yours · domain · marketplace), DLS-scoped.',
    mimeType: 'application/json',
    tab: 'files',
    minRole: 'creator',
    read: async (user) => json(listFiles(P(user))),
  },
  {
    uri: 'sovereign-os://my/metrics',
    name: 'my-metrics',
    title: 'My metrics',
    description: 'Governed metric members you can see — the one definition of every number.',
    mimeType: 'application/json',
    tab: 'metrics',
    minRole: 'creator',
    read: async (user) => json(listMetrics(P(user))),
  },
  {
    uri: 'sovereign-os://my/dashboards',
    name: 'my-dashboards',
    title: 'My dashboards',
    description: 'Dashboards you can see, DLS-scoped.',
    mimeType: 'application/json',
    tab: 'dashboards',
    minRole: 'creator',
    read: async (user) => json(listDashboards(P(user))),
  },
  {
    uri: 'sovereign-os://my/agents',
    name: 'my-agents',
    title: 'My agent systems',
    description: 'Agent systems you can see (yours · domain · marketplace).',
    mimeType: 'application/json',
    tab: 'agents',
    minRole: 'creator',
    read: async (user) => json(listSystems(P(user))),
  },
  {
    uri: 'sovereign-os://my/software',
    name: 'my-software',
    title: 'My software',
    description: 'Apps you can see (yours · domain · shared).',
    mimeType: 'application/json',
    tab: 'software',
    minRole: 'creator',
    read: async (user) => json(await listAppsForUser(user)),
  },
  {
    uri: 'sovereign-os://my/science',
    name: 'my-science',
    title: 'My models',
    description: 'ML models you can score through the governed predict door (tier-scoped: yours · domain · marketplace), plus whether serving (ml.enabled) is on. Honest: predict 404s while ml is disabled.',
    mimeType: 'application/json',
    tab: 'science',
    minRole: 'creator',
    read: async (user) =>
      json({
        mlEnabled: config.mlEnabled,
        models: listModelsForUser({ id: user.id, domains: user.domains }),
      }),
  },
  {
    uri: 'sovereign-os://my/pillars',
    name: 'my-pillars',
    title: 'My strategy pillars',
    description: 'Strategy pillars you can see (tenant + your domain), the value spine bets roll up to. Reuse before creating.',
    mimeType: 'application/json',
    tab: 'strategy',
    minRole: 'creator',
    read: async (user) => json(await listPillars(user)),
  },
  {
    uri: 'sovereign-os://my/bigbets',
    name: 'my-bigbets',
    title: 'My big bets',
    description: 'Big Bets you can see — initiative roadmaps over real OS components.',
    mimeType: 'application/json',
    tab: 'bigbets',
    minRole: 'creator',
    read: async (user) => json(listBets(P(user))),
  },
];

export const RESOURCES: McpResource[] = [...guideResources, buildSpecResource, ...myResources];

// ============================== TEMPLATES =====================================
export const RESOURCE_TEMPLATES: McpResourceTemplate[] = [
  {
    uriTemplate: 'sovereign-os://dataset/{id}',
    name: 'dataset',
    title: 'Dataset by id',
    description: 'One dataset you can see (medallion versions, docs, tier).',
    mimeType: 'application/json',
    tab: 'data',
    minRole: 'creator',
    read: async (user, p) => json(getDataset(p.id, P(user))),
  },
  {
    uriTemplate: 'sovereign-os://workflow/{id}',
    name: 'workflow',
    title: 'Knowledge workflow by id',
    description: 'One knowledge workflow you can see (steps, rules, tacit).',
    mimeType: 'application/json',
    tab: 'knowledge',
    minRole: 'creator',
    read: async (user, p) => json(getWorkflow(p.id, P(user))),
  },
  {
    uriTemplate: 'sovereign-os://file/{id}',
    name: 'file',
    title: 'File by id',
    description: 'One file you can see (metadata, docs, sensitivity).',
    mimeType: 'application/json',
    tab: 'files',
    minRole: 'creator',
    read: async (user, p) => json(getFile(p.id, P(user))),
  },
  {
    uriTemplate: 'sovereign-os://connection/{id}',
    name: 'connection',
    title: 'Connection by id',
    description: 'One connection you can see (never the raw credential).',
    mimeType: 'application/json',
    tab: 'connections',
    minRole: 'creator',
    read: async (user, p) => json(await getConnectionForUser(p.id, user)),
  },
  {
    uriTemplate: 'sovereign-os://agent/{id}',
    name: 'agent',
    title: 'Agent system by id',
    description: 'One agent system you can see (system.yaml, agents, grants).',
    mimeType: 'application/json',
    tab: 'agents',
    minRole: 'creator',
    read: async (user, p) => json(getSystem(p.id, P(user))),
  },
  {
    uriTemplate: 'sovereign-os://app/{id}',
    name: 'app',
    title: 'App by id',
    description: 'One app you can see (template, consumed resources, lifecycle).',
    mimeType: 'application/json',
    tab: 'software',
    minRole: 'creator',
    read: async (user, p) => json(await getAppForUser(p.id, user)),
  },
  {
    uriTemplate: 'sovereign-os://dashboard/{id}',
    name: 'dashboard',
    title: 'Dashboard by id',
    description: 'One dashboard you can see (charts bound to governed members).',
    mimeType: 'application/json',
    tab: 'dashboards',
    minRole: 'creator',
    read: async (user, p) => json(getDashboard(p.id, P(user))),
  },
  {
    uriTemplate: 'sovereign-os://bet/{id}',
    name: 'bet',
    title: 'Big Bet by id',
    description: 'One Big Bet you can see (components, target, status).',
    mimeType: 'application/json',
    tab: 'bigbets',
    minRole: 'creator',
    read: async (user, p) => json(getBet(p.id, P(user))),
  },
];

// --- Endpoint scoping (mirrors toolsForTab): a tab serves its own + meta -------
export function resourcesForTab(tab: McpTab, all: McpResource[] = RESOURCES): McpResource[] {
  return all.filter((r) => r.tab === tab || r.tab === 'meta');
}
export function templatesForTab(tab: McpTab, all: McpResourceTemplate[] = RESOURCE_TEMPLATES): McpResourceTemplate[] {
  return all.filter((r) => r.tab === tab || r.tab === 'meta');
}
