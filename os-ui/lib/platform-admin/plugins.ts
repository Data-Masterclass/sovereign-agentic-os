/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Plugins & Marketplace adapter. Admins CURATE which plugins (MCP servers,
 * skills, tool bundles) are installed and which domains may use them, and manage
 * the EXTERNAL STACKIT marketplace registration (distinct from the internal
 * cross-domain Company-scope product catalogue). Install is a trust decision: a plugin
 * carries a signed/scanned status before an Admin may approve it.
 *
 * DURABILITY: plugin enablement (install → approve → allowed domains) and the
 * STACKIT marketplace registration are written THROUGH to the OpenSearch mirror
 * (`os-plugins`, one doc per plugin plus a `__registration__` doc) and hydrated on
 * boot — without this a pod roll reverted an admin's install/approve decisions and
 * the marketplace registration to unset while the audit row claimed they persisted.
 * FAIL-SOFT: an unreachable mirror keeps the in-process state. "Install" here flips
 * a governed enablement flag — it does not provision infrastructure. Unit-testable.
 */
import { osMirror } from '../infra/os-mirror.ts';

export type PluginKind = 'mcp' | 'skill' | 'tool';
export type PluginStatus = 'available' | 'installed' | 'approved';

export type Plugin = {
  id: string;
  name: string;
  kind: PluginKind;
  publisher: string;
  signed: boolean;
  scanned: boolean;
  status: PluginStatus;
  /** Domains permitted to use it once approved. */
  allowedDomains: string[];
  summary: string;
};

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

type PluginsState = { plugins: Map<string, Plugin>; registration: MarketplaceRegistration; hydration: Promise<void> | null };
const PLUGINS_KEY = Symbol.for('soa.platform.plugins');
function pluginsState(): PluginsState {
  const g = globalThis as unknown as Record<symbol, PluginsState | undefined>;
  if (!g[PLUGINS_KEY]) g[PLUGINS_KEY] = { plugins: new Map(), registration: defaultRegistration(), hydration: null };
  return g[PLUGINS_KEY]!;
}
function pluginsStore(): Map<string, Plugin> {
  return pluginsState().plugins;
}

// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/infra/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.
const mirror = osMirror({ index: 'os-plugins' });
const REGISTRATION_ID = '__registration__';

function seed(): void {
  // A fresh tenant starts EMPTY — admins install plugins from the marketplace.
  // No demo plugins are baked in.
}

function persistPlugin(p: Plugin): void {
  mirror.writeThrough(`plugin_${p.id}`, { docId: `plugin_${p.id}`, plugin: p });
}
function persistRegistration(r: MarketplaceRegistration): void {
  mirror.writeThrough(REGISTRATION_ID, { docId: REGISTRATION_ID, registration: r });
}

/** Hydrate plugin enablement + marketplace registration once from the mirror. A
 *  stored plugin doc overwrites the in-process entry; anything unreachable keeps
 *  the current state. FAIL-SOFT: an unreachable mirror never throws. */
export async function ensureHydrated(): Promise<void> {
  const s = pluginsState();
  if (!s.hydration) s.hydration = hydratePlugins();
  return s.hydration;
}

async function hydratePlugins(): Promise<void> {
  const docs = await mirror.hydrate(500); // null → mirror down → keep in-memory state
  if (docs === null) return;
  const s = pluginsState();
  for (const d of docs as { docId?: string; plugin?: Plugin; registration?: MarketplaceRegistration }[]) {
    if (d?.docId === REGISTRATION_ID && d.registration) {
      s.registration = d.registration;
    } else if (d?.plugin && typeof d.plugin.id === 'string') {
      s.plugins.set(d.plugin.id, d.plugin);
    }
  }
}

export function listPlugins(): Plugin[] {
  seed();
  return [...pluginsStore().values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function installPlugin(id: string): Plugin {
  seed();
  const p = pluginsStore().get(id);
  if (!p) throw fail('Unknown plugin', 404);
  if (!p.signed || !p.scanned) throw fail('Plugin must be signed AND scanned before install', 409);
  if (p.status === 'available') p.status = 'installed';
  persistPlugin(p);
  return p;
}

export function approvePlugin(id: string, domains: string[]): Plugin {
  seed();
  const p = pluginsStore().get(id);
  if (!p) throw fail('Unknown plugin', 404);
  if (p.status === 'available') throw fail('Install the plugin before approving it for domains', 409);
  p.status = 'approved';
  p.allowedDomains = [...new Set(domains.map((d) => d.trim()).filter(Boolean))];
  persistPlugin(p);
  return p;
}

export type MarketplaceRegistration = {
  registered: boolean;
  listingName: string;
  partnerId: string;
  status: 'unregistered' | 'pending' | 'listed';
};

function defaultRegistration(): MarketplaceRegistration {
  return { registered: false, listingName: 'Sovereign Agentic OS — Data Masterclass', partnerId: '', status: 'unregistered' };
}

export function getRegistration(): MarketplaceRegistration {
  return pluginsState().registration;
}

export function registerMarketplace(input: { listingName?: string; partnerId: string }): MarketplaceRegistration {
  if (!input.partnerId.trim()) throw fail('A STACKIT partner id is required', 400);
  const s = pluginsState();
  s.registration = {
    registered: true,
    listingName: input.listingName?.trim() || s.registration.listingName,
    partnerId: input.partnerId.trim(),
    status: 'pending',
  };
  persistRegistration(s.registration);
  return s.registration;
}

export function _reset(): void {
  const s = pluginsState();
  s.plugins.clear();
  s.registration = defaultRegistration();
  s.hydration = null;
  mirror.__reset();
}

/** Test hook: register plugins so the install/approve gates can be exercised.
 *  Production curates plugins via the marketplace, not a baked-in seed. */
export function __seedPlugins(rows: Plugin[]): void {
  for (const p of rows) pluginsStore().set(p.id, p);
}
