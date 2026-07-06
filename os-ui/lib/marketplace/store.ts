/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { osMirror } from '@/lib/os-mirror';
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
  // A fresh tenant starts EMPTY, and stays honest: the Marketplace is NOT empty
  // in practice because `allListings()` unions in the REAL certified artifacts
  // from `lib/artifacts.ts` (anything promoted to Certified surfaces as a
  // listing). Starter/example listings are therefore NOT hard-coded here — they
  // are published only through the platform's own governed certify flows (the
  // exercise seed, e.g. the Northpeak / e-commerce case study), so no code path
  // ever fabricates a listing that pretends to be a certified product.
  return [];
}


// Pinned to globalThis (same reason as the live state below): the App Router
// bundles route handlers separately, so a module-scoped `let` would give each
// route its own catalog copy. One shared instance keeps listings consistent.
const CATALOG_KEY = Symbol.for('soa.marketplace.catalog');
export function mockCatalog(): MockProduct[] {
  const g = globalThis as unknown as Record<symbol, MockProduct[] | undefined>;
  if (!g[CATALOG_KEY]) g[CATALOG_KEY] = seed();
  return g[CATALOG_KEY]!;
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
  hydration: Promise<void> | null;
};

const STATE_KEY = Symbol.for('soa.marketplace.state');
function state(): MarketplaceState {
  const g = globalThis as unknown as Record<symbol, MarketplaceState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = { grants: new Map(), ratings: new Map(), deprecated: new Set(), audit: [], hydration: null };
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
// Shared durable-mirror core (lib/os-mirror.ts): first write probes the cluster
// and CREATES the index when missing, so the mirror works on a fresh deploy.

const grantsMirror = osMirror({ index: 'os-marketplace-grants' });
const auditMirror = osMirror({ index: 'os-marketplace-audit' });
const ratingsMirror = osMirror({ index: 'os-marketplace-ratings' });
const deprecatedMirror = osMirror({ index: 'os-marketplace-deprecated' });

export async function ensureHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = state();
  // Hydrate grants
  const grants = (await grantsMirror.hydrate(2000)) ?? [];
  for (const g of grants as Grant[]) {
    if (g && g.id && !s.grants.has(g.id)) s.grants.set(g.id, g);
  }
  // Hydrate audit (sort chronologically)
  const audit = (await auditMirror.hydrate(1000)) ?? [];
  const sorted = (audit as AuditEvent[])
    .filter((e) => e && e.id)
    .sort((a, b) => b.at.localeCompare(a.at)); // newest-first to match unshift order
  for (const e of sorted) {
    if (!s.audit.find((a) => a.id === e.id)) s.audit.push(e);
  }
  // Hydrate ratings
  const ratings = (await ratingsMirror.hydrate(5000)) ?? [];
  for (const r of ratings as { listingId?: string; user?: string; stars?: number }[]) {
    if (!r || !r.listingId || !r.user) continue;
    const list = s.ratings.get(r.listingId) ?? [];
    if (!list.find((x) => x.user === r.user)) {
      list.push({ user: r.user, stars: r.stars ?? 0 });
      s.ratings.set(r.listingId, list);
    }
  }
  // Hydrate deprecated
  const deprecated = (await deprecatedMirror.hydrate(1000)) ?? [];
  for (const d of deprecated as { id?: string }[]) {
    if (d && d.id) s.deprecated.add(d.id);
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
  auditMirror.writeThrough(full.id, full);
  void langfuseAudit(full);
  return full;
}

export function listAudit(opts: { listingId?: string } = {}): AuditEvent[] {
  return state().audit.filter((a) => (opts.listingId ? a.listingId === opts.listingId : true));
}

export function putGrant(g: Grant): Grant {
  state().grants.set(g.id, g);
  grantsMirror.writeThrough(g.id, g);
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
  ratingsMirror.writeThrough(`${listingId}:${user}`, { listingId, user, stars });
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
  deprecatedMirror.writeThrough(listingId, { id: listingId, deprecated: true });
}

export function __resetMarketplace(): void {
  const s = state();
  s.grants.clear();
  s.ratings.clear();
  s.deprecated.clear();
  s.audit.length = 0;
  s.hydration = null;
  grantsMirror.__reset();
  auditMirror.__reset();
  ratingsMirror.__reset();
  deprecatedMirror.__reset();
}

export type { Grant, Listing };
