/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Domain adapter — the structural map of the tenant. Admins create / rename /
 * archive / transfer domains, set an owner + defaults, and toggle each domain's
 * OPTIONAL layers (`ml.enabled`, `spark.enabled`) — so enabling ML in a domain
 * is a click here, not a Helm edit. Domain templates seed sensible defaults.
 *
 * The layer toggles only flip a governed flag on an ALREADY-provisioned layer
 * (no prod provisioning from the UI). The flag compiles through the policy
 * compiler so the `ml` / `spark` tool grant follows the toggle.
 *
 * Pure in-memory store (durable mirror happens at the route/app-tier seam);
 * unit-testable.
 */

export type DomainLayers = { ml: boolean; spark: boolean };

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
  { id: 'blank', name: 'Blank', description: 'Core data + agents only.', layers: { ml: false, spark: false } },
  { id: 'analytics', name: 'Analytics', description: 'Core + dashboards; no heavy ML.', layers: { ml: false, spark: false } },
  { id: 'science', name: 'Data Science', description: 'Adds the ML layer (Layer 4).', layers: { ml: true, spark: false } },
  { id: 'big-data', name: 'Big Data', description: 'Adds Spark for large batch.', layers: { ml: false, spark: true } },
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

const store = new Map<string, Domain>();

function seed(): void {
  if (store.size > 0) return;
  for (const d of [
    { id: 'sales', name: 'Sales', owner: 'sara' },
    { id: 'finance', name: 'Finance', owner: 'maria' },
  ]) {
    store.set(d.id, {
      id: d.id,
      name: d.name,
      owner: d.owner,
      archived: false,
      layers: { ml: false, spark: false },
      template: 'analytics',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }
}

export function listDomains(): Domain[] {
  seed();
  return [...store.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getDomain(id: string): Domain {
  seed();
  const d = store.get(id);
  if (!d) throw fail('Domain not found', 404);
  return d;
}

export function createDomain(input: { name: string; owner: string; template?: string }): Domain {
  seed();
  const id = slug(input.name);
  if (!id) throw fail('A domain name is required', 400);
  if (store.has(id)) throw fail('That domain already exists', 409);
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
  store.set(id, d);
  return d;
}

export function renameDomain(id: string, name: string): Domain {
  const d = getDomain(id);
  d.name = name.trim() || d.name;
  return d;
}

export function setArchived(id: string, archived: boolean): Domain {
  const d = getDomain(id);
  d.archived = archived;
  return d;
}

export function transferDomain(id: string, owner: string): Domain {
  const d = getDomain(id);
  const next = owner.trim();
  if (!next) throw fail('A new owner is required', 400);
  d.owner = next;
  return d;
}

export function setLayer(id: string, layer: keyof DomainLayers, enabled: boolean): Domain {
  const d = getDomain(id);
  if (d.archived) throw fail('Cannot change layers on an archived domain', 409);
  d.layers = { ...d.layers, [layer]: enabled };
  return d;
}

/** Shape the policy compiler consumes (id + archived + layers). */
export function compilerView(): { id: string; archived: boolean; layers: DomainLayers }[] {
  return listDomains().map((d) => ({ id: d.id, archived: d.archived, layers: d.layers }));
}

export function _reset(): void {
  store.clear();
}
