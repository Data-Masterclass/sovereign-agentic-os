/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import type {
  Grant,
  Listing,
  PreviewSample,
  LineageNode,
  ProductType,
  ImportMode,
} from './types';

/**
 * Marketplace state store — grants, ratings, usage and audit, plus the
 * offline-mock certified catalog. Same dual pattern as `lib/artifacts.ts` and
 * `lib/approvals.ts`: an authoritative in-process store so the teaching/gate
 * flows work with NO cluster, with best-effort OpenSearch write-through (durable
 * mirror) and best-effort Langfuse audit. The scoping/grant rules are the
 * security boundary regardless of backing store.
 *
 * The catalog here SUPPLEMENTS the real certified artifacts (lib/artifacts.ts):
 * it carries the cross-tab product types the artifact registry doesn't model yet
 * (apps, connection templates) and the worked-example gate fixtures (Sales
 * dashboard / knowledge / connection) with preview rows + lineage. Product tabs
 * live on parallel branches; at consolidation these mock sources are swapped for
 * the real per-tab registries behind the same `MockProduct` shape.
 */

// ------------------------------------------------------------- mock catalog --

export type MockProduct = {
  id: string;
  type: ProductType;
  name: string;
  description: string;
  owner: string;
  ownerDomain: string;
  tags: string[];
  registry: 'openmetadata' | 'os-registry';
  quality: number;
  freshness: number;
  /** Rows the read-grant RLS filters; tagged by `domain` for cross-domain proof. */
  previewColumns?: string[];
  previewRows?: string[][];
  previewText?: string;
  previewSpec?: Record<string, unknown>;
  /** Upstream sources (downstream importers are derived from grants). */
  upstream?: LineageNode[];
  /** Modes that share owner creds/compute default to approval; owner may override. */
  accessPolicyOverride?: 'open' | 'approval';
};

/** The worked-example catalog (marketplace-golden-path.md §"Worked example"). */
function seed(): MockProduct[] {
  return [
    {
      id: 'mkt_revenue',
      type: 'metric',
      name: 'Revenue',
      description: 'Certified company metric: revenue by day from the Cube semantic layer. Read in place under your own identity — RLS scopes you to your domain’s rows.',
      owner: 'sara',
      ownerDomain: 'sales',
      tags: ['cube', 'revenue', 'certified'],
      registry: 'openmetadata',
      quality: 0.98,
      freshness: 0.95,
      previewColumns: ['domain', 'day', 'revenue'],
      previewRows: [
        ['sales', '2026-06-28', '12,000'],
        ['sales', '2026-06-29', '13,500'],
        ['marketing', '2026-06-28', '4,200'],
        ['marketing', '2026-06-29', '5,100'],
        ['finance', '2026-06-29', '9,900'],
      ],
      previewSpec: { cube: 'daily_revenue', measures: ['DailyRevenue.amount'], dimensions: ['DailyRevenue.day'] },
      upstream: [
        { id: 'tbl_orders', name: 'stg_orders', type: 'dataset', relation: 'upstream', domain: 'sales' },
      ],
    },
    {
      id: 'mkt_sales_overview',
      type: 'dashboard',
      name: 'Sales Overview',
      description: 'Certified Superset dashboard on the governed Revenue metric. Embed it — it runs on the metric with YOUR row-level security.',
      owner: 'sara',
      ownerDomain: 'sales',
      tags: ['superset', 'overview', 'certified'],
      registry: 'os-registry',
      quality: 0.93,
      freshness: 0.88,
      previewText: 'Panels: Revenue by day · Top customers · Pipeline by stage. Each panel re-runs under the embedding viewer’s Cube securityContext.',
      previewSpec: { panels: ['revenue_by_day', 'top_customers', 'pipeline'], metric: 'daily_revenue' },
      upstream: [
        { id: 'mkt_revenue', name: 'Revenue', type: 'metric', relation: 'upstream', domain: 'sales' },
      ],
    },
    {
      id: 'mkt_bank_submission',
      type: 'knowledge',
      name: 'Bank submission',
      description: 'Certified knowledge product: the process + rules for bank submissions. Read it via your agents (RLS), or fork-to-adapt the workflow to your domain.',
      owner: 'bea',
      ownerDomain: 'sales',
      tags: ['process', 'compliance', 'certified'],
      registry: 'os-registry',
      quality: 0.9,
      freshness: 0.8,
      previewText: '§1 Eligibility · §2 Required documents · §3 Submission workflow · §4 Approval thresholds. Indexed for retrieval with Document-Level Security.',
      previewSpec: { index: 'knowledge', docs: 14 },
    },
    {
      id: 'mkt_salesforce_tpl',
      type: 'connection',
      name: 'Salesforce',
      description: 'Certified connection template to Salesforce. Import it to create your own connection — bring your own credentials (stored in the secrets store, never the browser).',
      owner: 'sara',
      ownerDomain: 'sales',
      tags: ['crm', 'template', 'certified'],
      registry: 'os-registry',
      quality: 0.95,
      freshness: 0.9,
      previewText: 'Template: host, OAuth client, default objects (Account, Opportunity). Credentials are NOT shared — each importer binds their own.',
      previewSpec: { connector: 'salesforce', objects: ['Account', 'Opportunity'], capability: 'crm.read' },
      accessPolicyOverride: 'approval',
    },
    {
      id: 'mkt_domain_rag',
      type: 'agent',
      name: 'Domain RAG Agent',
      description: 'Certified LangGraph retrieve→generate→trace agent. Fork it to own an editable copy governed in your domain.',
      owner: 'admin',
      ownerDomain: 'platform',
      tags: ['langgraph', 'rag', 'certified'],
      registry: 'os-registry',
      quality: 0.92,
      freshness: 0.85,
      previewSpec: { graph: ['retrieve', 'generate', 'trace'], tools: ['knowledge_search'] },
    },
    {
      id: 'mkt_lead_scorer',
      type: 'app',
      name: 'Lead Scorer',
      description: 'Certified Software app. Deploy your own instance (your Supabase + connections); a shared instance is available for trusted cases.',
      owner: 'admin',
      ownerDomain: 'platform',
      tags: ['software', 'nextjs', 'certified'],
      registry: 'os-registry',
      quality: 0.88,
      freshness: 0.82,
      previewText: 'A Next.js app that scores leads from your CRM connection. Deploying provisions an isolated instance in your namespace.',
      previewSpec: { template: 'nextjs-app', needs: ['connection:crm'] },
      accessPolicyOverride: 'approval',
    },
  ];
}

let catalog: MockProduct[] | null = null;
export function mockCatalog(): MockProduct[] {
  if (!catalog) catalog = seed();
  return catalog;
}

export function mockProduct(id: string): MockProduct | undefined {
  return mockCatalog().find((p) => p.id === id);
}

/** Build the RLS-target preview sample for a product (rows pre-filtered by caller). */
export function basePreview(p: MockProduct): PreviewSample {
  if (p.previewRows && p.previewColumns) {
    return { kind: 'rows', columns: p.previewColumns, rows: p.previewRows };
  }
  if (p.previewText) return { kind: 'text', text: p.previewText };
  return { kind: 'spec', text: JSON.stringify(p.previewSpec ?? {}, null, 2) };
}

// -------------------------------------------------------------- live state --

export type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: 'certify' | 'deprecate' | 'import' | 'import_requested' | 'rate' | 'revoke';
  listingId: string;
  detail: string;
  domain: string;
};

/**
 * State container. Kept on `globalThis` so it is a TRUE singleton: the Next.js
 * App Router bundles each route handler separately, which can otherwise give
 * every route its own copy of this module (and its own empty Maps). Pinning the
 * state to globalThis makes a grant written by the import route visible to the
 * detail / deprecate / governance routes — and survives dev HMR. (Same reason
 * Prisma/Redis clients are pinned to globalThis in Next apps.)
 */
type MarketplaceState = {
  grants: Map<string, Grant>;
  ratings: Map<string, { user: string; stars: number }[]>;
  deprecated: Set<string>;
  audit: AuditEvent[];
};

const STATE_KEY = Symbol.for('soa.marketplace.state');
function state(): MarketplaceState {
  const g = globalThis as unknown as Record<symbol, MarketplaceState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = { grants: new Map(), ratings: new Map(), deprecated: new Set(), audit: [] };
  }
  return g[STATE_KEY]!;
}

function now(): string {
  return new Date().toISOString();
}
function rid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

// -------------------------------------------------- OpenSearch write-through --

async function osWrite(index: string, id: string, doc: unknown): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    await fetch(`${config.opensearchUrl}/${index}/_doc/${id}?refresh=true`, {
      method: 'PUT',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(doc),
    });
  } catch {
    /* best-effort durable mirror */
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort Langfuse audit event (usage/lineage trail). Never blocks. */
async function langfuseAudit(e: AuditEvent): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const auth = 'Basic ' + Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
    await fetch(`${config.langfuseUrl}/api/public/ingestion`, {
      method: 'POST',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        batch: [
          {
            id: e.id,
            type: 'event-create',
            timestamp: e.at,
            body: { name: `marketplace.${e.action}`, metadata: e },
          },
        ],
      }),
    });
  } catch {
    /* best-effort */
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------- accessors --

export function recordAudit(e: Omit<AuditEvent, 'id' | 'at'>): AuditEvent {
  const full: AuditEvent = { ...e, id: rid('aud'), at: now() };
  state().audit.unshift(full);
  void osWrite('os-marketplace-audit', full.id, full);
  void langfuseAudit(full);
  return full;
}

export function listAudit(opts: { listingId?: string } = {}): AuditEvent[] {
  return state().audit.filter((a) => (opts.listingId ? a.listingId === opts.listingId : true));
}

export function putGrant(g: Grant): Grant {
  state().grants.set(g.id, g);
  void osWrite('os-marketplace-grants', g.id, g);
  return g;
}

export function newGrantId(): string {
  return rid('grant');
}

export function getGrant(id: string): Grant | undefined {
  return state().grants.get(id);
}

export function allGrants(): Grant[] {
  return [...state().grants.values()];
}

export function grantsForListing(listingId: string): Grant[] {
  return [...state().grants.values()].filter((g) => g.listingId === listingId);
}

export function grantsForUser(userId: string): Grant[] {
  return [...state().grants.values()]
    .filter((g) => g.granteeUser === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Find an existing live grant for (listing, user, mode) — imports are idempotent. */
export function findGrant(listingId: string, userId: string, mode: ImportMode): Grant | undefined {
  return [...state().grants.values()].find(
    (g) => g.listingId === listingId && g.granteeUser === userId && g.mode === mode && g.status !== 'revoked',
  );
}

export function rate(listingId: string, user: string, stars: number): void {
  const ratings = state().ratings;
  const list = ratings.get(listingId) ?? [];
  const existing = list.find((r) => r.user === user);
  if (existing) existing.stars = stars;
  else list.push({ user, stars: Math.max(1, Math.min(5, stars)) });
  ratings.set(listingId, list);
  void osWrite('os-marketplace-ratings', `${listingId}:${user}`, { listingId, user, stars });
}

export function ratingFor(listingId: string): { rating: number; ratingCount: number } {
  const list = state().ratings.get(listingId) ?? [];
  if (list.length === 0) return { rating: 0, ratingCount: 0 };
  const sum = list.reduce((s, r) => s + r.stars, 0);
  return { rating: Math.round((sum / list.length) * 10) / 10, ratingCount: list.length };
}

export function isDeprecated(listingId: string): boolean {
  return state().deprecated.has(listingId);
}

export function setDeprecated(listingId: string): void {
  state().deprecated.add(listingId);
}

export type { Grant, Listing };
