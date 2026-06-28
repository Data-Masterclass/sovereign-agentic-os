/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { config } from '@/lib/config';
import {
  type Artifact,
  type ArtifactType,
  type Visibility,
  type ArtifactOrigin,
} from '@/lib/artifact-model';
import { canPromote } from '@/lib/session';
import type { CurrentUser } from '@/lib/auth';

/**
 * Artifact registry + scoping logic — the server-side enforcement point for the
 * Personal / Shared / Certified visibility model.
 *
 * Persistence: best-effort OpenSearch ("os-artifacts" index) as the durable
 * mirror, with an authoritative in-process cache so the teaching flows work with
 * NO live cluster. On first use we hydrate the cache from OpenSearch if it is
 * reachable; every mutation writes through to OpenSearch (fire-and-forget) so a
 * real deployment is durable, while local/dev keeps everything in memory. The
 * scoping rules below are the security boundary regardless of backing store.
 */

let cache: Map<string, Artifact> | null = null;
let osHealthy = false;

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

// ---------------------------------------------------------------- OpenSearch --

async function osFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureIndex(): Promise<void> {
  const head = await osFetch(`/${config.artifactsIndex}`, { method: 'HEAD' });
  if (head && head.status === 404) {
    await osFetch(`/${config.artifactsIndex}`, {
      method: 'PUT',
      body: JSON.stringify({
        mappings: {
          properties: {
            type: { type: 'keyword' },
            owner: { type: 'keyword' },
            domain: { type: 'keyword' },
            visibility: { type: 'keyword' },
            origin: { type: 'keyword' },
            sourceId: { type: 'keyword' },
            name: { type: 'text' },
            description: { type: 'text' },
            tags: { type: 'keyword' },
            createdAt: { type: 'date' },
            updatedAt: { type: 'date' },
          },
        },
      }),
    });
  }
}

function writeThrough(a: Artifact): void {
  if (!osHealthy) return;
  // Fire-and-forget durable mirror; never block the request on it.
  void osFetch(`/${config.artifactsIndex}/_doc/${a.id}?refresh=true`, {
    method: 'PUT',
    body: JSON.stringify(a),
  });
}

function deleteThrough(artId: string): void {
  if (!osHealthy) return;
  void osFetch(`/${config.artifactsIndex}/_doc/${artId}?refresh=true`, { method: 'DELETE' });
}

// ------------------------------------------------------------------- Seeding --

function seed(): Artifact[] {
  const t = now();
  const mk = (a: Partial<Artifact> & Pick<Artifact, 'id' | 'type' | 'name' | 'owner' | 'domain' | 'visibility'>): Artifact => ({
    description: '',
    origin: 'authored',
    tags: [],
    spec: {},
    createdAt: t,
    updatedAt: t,
    ...a,
  });
  return [
    // sales domain
    mk({ id: 'seed_ds_orders', type: 'dataset', name: 'Raw orders', owner: 'amir', domain: 'sales', visibility: 'Personal', description: 'Imported orders.csv — one row per order line.', tags: ['raw', 'csv'], spec: { table: 'raw_orders', rows: 12048 } }),
    mk({ id: 'seed_ds_customers', type: 'dataset', name: 'Customers', owner: 'sara', domain: 'sales', visibility: 'Shared', description: 'Cleaned customer dimension shared across the Sales domain.', tags: ['dimension'], spec: { table: 'dim_customers', rows: 842 } }),
    mk({ id: 'seed_tr_daily', type: 'transformation', name: 'stg_orders → daily_revenue', owner: 'sara', domain: 'sales', visibility: 'Shared', description: 'dbt model aggregating orders to daily revenue.', tags: ['dbt', 'mart'], spec: { sql: 'select order_date as day, sum(amount) as revenue\nfrom {{ ref("stg_orders") }}\ngroup by 1', materialization: 'table' } }),
    // finance domain
    mk({ id: 'seed_ds_ledger', type: 'dataset', name: 'GL ledger', owner: 'kenji', domain: 'finance', visibility: 'Personal', description: 'General-ledger extract for Q-close.', tags: ['finance'], spec: { table: 'gl_ledger', rows: 50211 } }),
    mk({ id: 'seed_me_margin', type: 'metric', name: 'Gross margin %', owner: 'maria', domain: 'finance', visibility: 'Shared', description: 'Cube metric: gross margin as a percentage of revenue.', tags: ['cube'], spec: { measures: ['Finance.grossMargin'], dimensions: ['Finance.period'] } }),
    // Certified catalog (cross-domain Marketplace)
    mk({ id: 'seed_cert_revenue', type: 'metric', name: 'Daily revenue', owner: 'sara', domain: 'sales', visibility: 'Certified', description: 'Certified company metric: revenue by day from the Cube semantic layer.', tags: ['cube', 'certified', 'revenue'], spec: { cube: 'daily_revenue', measures: ['DailyRevenue.amount'], dimensions: ['DailyRevenue.day'] } }),
    mk({ id: 'seed_cert_kb', type: 'knowledge', name: 'Platform Knowledge Base', owner: 'admin', domain: 'platform', visibility: 'Certified', description: 'Certified knowledge index that grounds the domain RAG agent.', tags: ['rag', 'certified'], spec: { index: 'knowledge' } }),
    mk({ id: 'seed_cert_ragagent', type: 'agent', name: 'Domain RAG Agent', owner: 'admin', domain: 'platform', visibility: 'Certified', description: 'Certified LangGraph retrieve→generate→trace agent, governed by the gateway.', tags: ['langgraph', 'rag', 'certified'], spec: { graph: ['retrieve', 'generate', 'trace'], tools: ['knowledge_search'] } }),
  ];
}

async function getCache(): Promise<Map<string, Artifact>> {
  if (cache) return cache;
  const map = new Map<string, Artifact>();
  // Try to hydrate from OpenSearch; fall back to the in-memory seed.
  const ping = await osFetch(`/${config.artifactsIndex}/_count`);
  if (ping && ping.ok) {
    osHealthy = true;
    await ensureIndex();
    const res = await osFetch(`/${config.artifactsIndex}/_search?size=1000`, {
      method: 'POST',
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    if (res && res.ok) {
      const data = (await res.json()) as { hits?: { hits?: { _source: Artifact }[] } };
      const hits = data?.hits?.hits ?? [];
      for (const h of hits) map.set(h._source.id, h._source);
    }
    if (map.size === 0) {
      for (const a of seed()) {
        map.set(a.id, a);
        writeThrough(a);
      }
    }
  } else {
    osHealthy = false;
    for (const a of seed()) map.set(a.id, a);
  }
  cache = map;
  return map;
}

// ------------------------------------------------------------- Scoping rules --

/**
 * Workspace view for a user on the normal tabs: their own Personal artifacts +
 * every Shared artifact in their domain + any Certified COPIES they have added.
 * The global Certified catalog is intentionally excluded (it lives in the
 * Marketplace surface only).
 */
function visibleToUser(a: Artifact, user: CurrentUser): boolean {
  // Certified copies the user pulled from the Marketplace are theirs to see.
  if (a.origin === 'certified-copy') return a.owner === user.id;
  // Personal: owner only.
  if (a.visibility === 'Personal') return a.owner === user.id;
  // Shared: visible to everyone in that domain — but only for domains the user
  // belongs to.
  if (a.visibility === 'Shared') return user.domains.includes(a.domain);
  // Certified catalog items never show in normal tabs (Marketplace only).
  return false;
}

export async function listForUser(
  user: CurrentUser,
  opts: { type?: ArtifactType; visibility?: Visibility } = {},
): Promise<Artifact[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((a) => visibleToUser(a, user))
    .filter((a) => (opts.type ? a.type === opts.type : true))
    .filter((a) => (opts.visibility ? a.visibility === opts.visibility : true))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}

/** Cross-domain Certified catalog for the Marketplace. */
export async function listMarketplace(opts: { type?: ArtifactType } = {}): Promise<Artifact[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((a) => a.visibility === 'Certified' && a.origin === 'authored')
    .filter((a) => (opts.type ? a.type === opts.type : true))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}

export async function getArtifact(artId: string): Promise<Artifact | null> {
  const map = await getCache();
  return map.get(artId) ?? null;
}

export async function createArtifact(
  user: CurrentUser,
  input: { type: ArtifactType; name: string; description?: string; tags?: string[]; spec?: Record<string, unknown>; domain?: string },
): Promise<Artifact> {
  const map = await getCache();
  const t = now();
  // Create into one of the user's domains (default = their first).
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0];
  const a: Artifact = {
    id: id(input.type),
    type: input.type,
    name: input.name.trim() || 'Untitled',
    description: input.description?.trim() ?? '',
    owner: user.id,
    domain,
    visibility: 'Personal',
    origin: 'authored',
    tags: input.tags ?? [],
    spec: input.spec ?? {},
    createdAt: t,
    updatedAt: t,
  };
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

/**
 * Promotion: Personal → Shared (builder+) → Certified (admin only). The actor
 * must belong to the artifact's domain.
 */
export async function promoteArtifact(artId: string, user: CurrentUser): Promise<Artifact> {
  const map = await getCache();
  const a = map.get(artId);
  if (!a) throw withStatus(new Error('Artifact not found'), 404);
  if (a.origin === 'certified-copy') throw withStatus(new Error('Certified copies cannot be promoted'), 400);
  if (!user.domains.includes(a.domain)) {
    throw withStatus(new Error('You can only promote artifacts in a domain you belong to'), 403);
  }
  if (a.visibility === 'Personal') {
    if (!canPromote(user.role, 'Personal')) throw withStatus(new Error('Promoting to Shared requires a builder or admin'), 403);
    a.visibility = 'Shared';
  } else if (a.visibility === 'Shared') {
    if (!canPromote(user.role, 'Shared')) throw withStatus(new Error('Certifying to the Marketplace requires an admin'), 403);
    a.visibility = 'Certified';
  } else throw withStatus(new Error('Already Certified'), 400);
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

/** Add a Certified Marketplace artifact into the caller's own workspace. */
export async function addFromMarketplace(artId: string, user: CurrentUser): Promise<Artifact> {
  const map = await getCache();
  const src = map.get(artId);
  if (!src || src.visibility !== 'Certified' || src.origin !== 'authored') {
    throw withStatus(new Error('Not a Certified Marketplace artifact'), 404);
  }
  // Idempotent: if the user already added this source, return the existing copy.
  const existing = [...map.values()].find(
    (a) => a.origin === 'certified-copy' && a.sourceId === artId && a.owner === user.id,
  );
  if (existing) return existing;
  const t = now();
  const copy: Artifact = {
    ...src,
    id: id(`${src.type}_cert`),
    owner: user.id,
    // Keep the certifying domain as a label so the user sees where it came from.
    domain: src.domain,
    origin: 'certified-copy',
    sourceId: artId,
    createdAt: t,
    updatedAt: t,
  };
  map.set(copy.id, copy);
  writeThrough(copy);
  return copy;
}

export async function updateArtifact(
  artId: string,
  user: CurrentUser,
  patch: { name?: string; description?: string; tags?: string[]; spec?: Record<string, unknown> },
): Promise<Artifact> {
  const map = await getCache();
  const a = map.get(artId);
  if (!a) throw withStatus(new Error('Artifact not found'), 404);
  const isOwner = a.owner === user.id;
  const isDomainAdmin = user.role === 'admin' && user.domains.includes(a.domain);
  if (!isOwner && !isDomainAdmin) throw withStatus(new Error('Not permitted to edit this artifact'), 403);
  if (patch.name !== undefined) a.name = patch.name.trim() || a.name;
  if (patch.description !== undefined) a.description = patch.description;
  if (patch.tags !== undefined) a.tags = patch.tags;
  if (patch.spec !== undefined) a.spec = { ...a.spec, ...patch.spec };
  a.updatedAt = now();
  map.set(a.id, a);
  writeThrough(a);
  return a;
}

export async function deleteArtifact(artId: string, user: CurrentUser): Promise<void> {
  const map = await getCache();
  const a = map.get(artId);
  if (!a) return;
  const isOwner = a.owner === user.id;
  const isDomainAdmin = user.role === 'admin' && user.domains.includes(a.domain);
  if (!isOwner && !isDomainAdmin) throw withStatus(new Error('Not permitted to delete this artifact'), 403);
  map.delete(artId);
  deleteThrough(artId);
}

function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}

export type { Artifact, ArtifactType, Visibility, ArtifactOrigin };
