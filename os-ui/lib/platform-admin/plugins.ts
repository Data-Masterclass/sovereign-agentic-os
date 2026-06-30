/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Plugins & Marketplace adapter. Admins CURATE which plugins (MCP servers,
 * skills, tool bundles) are installed and which domains may use them, and manage
 * the EXTERNAL STACKIT marketplace registration (distinct from the internal
 * cross-domain product Marketplace tab). Install is a trust decision: a plugin
 * carries a signed/scanned status before an Admin may approve it.
 *
 * Pure store; unit-testable. "Install" here flips a governed enablement flag —
 * it does not provision infrastructure.
 */

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

const store = new Map<string, Plugin>();

function seed(): void {
  // A fresh tenant starts EMPTY — admins install plugins from the marketplace.
  // No demo plugins are baked in.
}

export function listPlugins(): Plugin[] {
  seed();
  return [...store.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function installPlugin(id: string): Plugin {
  seed();
  const p = store.get(id);
  if (!p) throw fail('Unknown plugin', 404);
  if (!p.signed || !p.scanned) throw fail('Plugin must be signed AND scanned before install', 409);
  if (p.status === 'available') p.status = 'installed';
  return p;
}

export function approvePlugin(id: string, domains: string[]): Plugin {
  seed();
  const p = store.get(id);
  if (!p) throw fail('Unknown plugin', 404);
  if (p.status === 'available') throw fail('Install the plugin before approving it for domains', 409);
  p.status = 'approved';
  p.allowedDomains = [...new Set(domains.map((d) => d.trim()).filter(Boolean))];
  return p;
}

export type MarketplaceRegistration = {
  registered: boolean;
  listingName: string;
  partnerId: string;
  status: 'unregistered' | 'pending' | 'listed';
};

let registration: MarketplaceRegistration = {
  registered: false,
  listingName: 'Sovereign Agentic OS — Data Masterclass',
  partnerId: '',
  status: 'unregistered',
};

export function getRegistration(): MarketplaceRegistration {
  return registration;
}

export function registerMarketplace(input: { listingName?: string; partnerId: string }): MarketplaceRegistration {
  if (!input.partnerId.trim()) throw fail('A STACKIT partner id is required', 400);
  registration = {
    registered: true,
    listingName: input.listingName?.trim() || registration.listingName,
    partnerId: input.partnerId.trim(),
    status: 'pending',
  };
  return registration;
}

export function _reset(): void {
  store.clear();
  registration = { registered: false, listingName: 'Sovereign Agentic OS — Data Masterclass', partnerId: '', status: 'unregistered' };
}

/** Test hook: register plugins so the install/approve gates can be exercised.
 *  Production curates plugins via the marketplace, not a baked-in seed. */
export function __seedPlugins(rows: Plugin[]): void {
  for (const p of rows) store.set(p.id, p);
}
