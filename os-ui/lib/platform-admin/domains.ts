/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Domain adapter — the structural map of the tenant. Admins create / rename /
 * archive / transfer domains, set an owner + defaults, and toggle each domain's
 * OPTIONAL ML layer (`ml.enabled`) — so enabling Science/ML in a domain is a
 * click here, not a Helm edit. Domain templates seed sensible defaults.
 *
 * The ML layer toggle only flips a governed flag on an ALREADY-provisioned
 * layer (no prod provisioning from the UI). The flag compiles through the
 * policy compiler so the `ml` OPA tool grant follows the toggle.
 *
 * In-memory fast cache + a best-effort OpenSearch mirror ("os-domains"), hydrated
 * once at the route/app-tier seam. Kept free of `server-only`/users imports (only
 * `config` + global `fetch`) so it stays unit-testable — the derive-from-users
 * step is INJECTED (see {@link ensureHydrated}).
 */

import { config } from '../config.ts';
import { osMirror } from '../os-mirror.ts';

export type DomainLayers = { ml: boolean };

export type Domain = {
  id: string;
  name: string;
  owner: string;
  archived: boolean;
  layers: DomainLayers;
  /** Which template seeded it (audit/provenance). */
  template: string;
  createdAt: string;
};

export type DomainTemplate = {
  id: string;
  name: string;
  description: string;
  layers: DomainLayers;
};

export const TEMPLATES: DomainTemplate[] = [
  { id: 'blank', name: 'Blank', description: 'Core data + agents only.', layers: { ml: false } },
  { id: 'analytics', name: 'Analytics', description: 'Core + dashboards; no heavy ML.', layers: { ml: false } },
  { id: 'science', name: 'Data Science', description: 'Adds the ML layer (Layer 4).', layers: { ml: true } },
  { id: 'big-data', name: 'Big Data', description: 'Core data + agents; large-batch processing.', layers: { ml: false } },
];

function now(): string {
  return new Date().toISOString();
}
function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}
function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

type DomainsState = { store: Map<string, Domain>; hydration: Promise<void> | null };
const DOMAINS_KEY = Symbol.for('soa.platform.domains');
function domainsState(): DomainsState {
  const g = globalThis as unknown as Record<symbol, DomainsState | undefined>;
  if (!g[DOMAINS_KEY]) g[DOMAINS_KEY] = { store: new Map(), hydration: null };
  return g[DOMAINS_KEY]!;
}

function seed(): void {
  // A fresh tenant starts EMPTY — admins create their own domains. No demo
  // domains are baked in.
}

// ---------------------------------------------------- durable mirror + derivation --
/**
 * The platform-admin registry must reflect the tenant's REAL domains. Durability
 * mirrors the data/artifact stores: this Map is the fast cache + a best-effort
 * OpenSearch mirror ("os-domains"). {@link ensureHydrated} (awaited at the admin
 * seam) loads admin-edited domains from the mirror, then MERGES in the domains
 * derived from the tenant's users (so a fresh tenant whose users live in
 * platform/sales/marketing/ops is never shown as 0) WITHOUT clobbering edits, and
 * mirrors freshly-derived domains through so edits persist. Every path is graceful.
 */

// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.
const mirror = osMirror({
  index: config.domainsIndex,
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        name: { type: 'text' },
        owner: { type: 'keyword' },
        archived: { type: 'boolean' },
        template: { type: 'keyword' },
        createdAt: { type: 'date' },
        layers: { type: 'object', enabled: false },
      },
    },
  },
});

function writeThrough(d: Domain): void {
  mirror.writeThrough(d.id, d);
}

/**
 * Seed any MISSING domains from a set of names (default template), leaving
 * existing (possibly admin-edited) domains untouched. Pure + sync — the building
 * block the async {@link ensureHydrated} uses for the derive-from-users merge.
 * Returns the ids actually created.
 */
export function hydrateDomains(names: string[], opts: { owner?: string; template?: string } = {}): string[] {
  const tpl = TEMPLATES.find((t) => t.id === opts.template) ?? TEMPLATES[0];
  const owner = (opts.owner ?? 'admin').trim() || 'admin';
  const created: string[] = [];
  for (const name of names) {
    const id = slug(name);
    if (!id || domainsState().store.has(id)) continue;
    domainsState().store.set(id, { id, name: name.trim() || id, owner, archived: false, layers: { ...tpl.layers }, template: tpl.id, createdAt: now() });
    created.push(id);
  }
  return created;
}

/**
 * Hydrate the registry once per process, awaited at the admin/app-tier seam before
 * any read. `deriveDomains` is INJECTED (the server passes `users.knownDomains`) so
 * this module stays free of server-only/users imports. Idempotent + graceful.
 */
export async function ensureHydrated(deriveDomains: () => Promise<string[]>): Promise<void> {
  const s = domainsState();
  if (!s.hydration) s.hydration = hydrate(deriveDomains);
  return s.hydration;
}

async function hydrate(deriveDomains: () => Promise<string[]>): Promise<void> {
  const st = domainsState();
  // 1. Load admin-edited domains from the durable mirror, if reachable.
  const docs = (await mirror.hydrate(1000)) ?? []; // null → mirror down → in-memory only
  for (const d of docs as Domain[]) {
    if (d && d.id && !st.store.has(d.id)) st.store.set(d.id, d);
  }
  // 2. Merge in the tenant's real domains (from its users) — never clobbering edits.
  let derived: string[] = [];
  try {
    derived = await deriveDomains();
  } catch {
    derived = [];
  }
  const created = hydrateDomains(derived);
  // 3. Persist the freshly-derived domains so admin edits on them will persist too.
  for (const id of created) {
    const d = domainsState().store.get(id);
    if (d) writeThrough(d);
  }
}

export function listDomains(): Domain[] {
  seed();
  return [...domainsState().store.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getDomain(id: string): Domain {
  seed();
  const d = domainsState().store.get(id);
  if (!d) throw fail('Domain not found', 404);
  return d;
}

/**
 * Narrow a list of domain ids to the ones that are NOT archived. An archived
 * domain must disappear from a member's active scope (e.g. the sidebar switcher)
 * even though their membership record still lists it. Unknown ids are KEPT
 * (defensive — synthetic scopes like `platform`, or a domain not yet hydrated).
 */
export function activeDomainIds(ids: string[]): string[] {
  seed();
  const store = domainsState().store;
  return ids.filter((id) => {
    const d = store.get(id);
    return !d || !d.archived;
  });
}

export function createDomain(input: { name: string; owner: string; template?: string }): Domain {
  seed();
  const id = slug(input.name);
  if (!id) throw fail('A domain name is required', 400);
  if (domainsState().store.has(id)) throw fail('That domain already exists', 409);
  const tpl = TEMPLATES.find((t) => t.id === input.template) ?? TEMPLATES[0];
  const d: Domain = {
    id,
    name: input.name.trim(),
    owner: input.owner.trim(),
    archived: false,
    layers: { ...tpl.layers },
    template: tpl.id,
    createdAt: now(),
  };
  domainsState().store.set(id, d);
  writeThrough(d); // best-effort durable mirror
  return d;
}

export function renameDomain(id: string, name: string): Domain {
  const d = getDomain(id);
  d.name = name.trim() || d.name;
  writeThrough(d);
  return d;
}

export function setArchived(id: string, archived: boolean): Domain {
  const d = getDomain(id);
  d.archived = archived;
  writeThrough(d);
  return d;
}

export function transferDomain(id: string, owner: string): Domain {
  const d = getDomain(id);
  const next = owner.trim();
  if (!next) throw fail('A new owner is required', 400);
  d.owner = next;
  writeThrough(d);
  return d;
}

export function setLayer(id: string, layer: keyof DomainLayers, enabled: boolean): Domain {
  const d = getDomain(id);
  if (d.archived) throw fail('Cannot change layers on an archived domain', 409);
  d.layers = { ...d.layers, [layer]: enabled };
  writeThrough(d);
  return d;
}

/** Shape the policy compiler consumes (id + archived + ml layer). */
export function compilerView(): { id: string; archived: boolean; layers: DomainLayers }[] {
  return listDomains().map((d) => ({ id: d.id, archived: d.archived, layers: d.layers }));
}

export function _reset(): void {
  const s = domainsState();
  s.store.clear();
  s.hydration = null;
  mirror.__reset();
}
