/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Shared types + tiny helpers for the Connections surface — the payload shapes the
 * `/api/connections` route returns and the vocabulary helpers (visibility → word,
 * capability-mode → badge). Extracted so the list (GovernedConnections), the View/Edit
 * builder (ConnectionBuilder) and the connector gallery all speak the SAME types
 * without a circular import. NOTHING here fetches or mutates — pure shapes + maps.
 */

import type { CapabilityMode } from '@/lib/connections/schema';
import type { Role } from '@/lib/core/session';
import type { Visibility } from '@/lib/core/lifecycle';
import type { OAuthProvider } from '@/lib/oauth/providers';

// ---- Types (mirror the /api/connections payload) ---------------------------

export type Tool = {
  name: string;
  description: string;
  write: boolean;
  mode: CapabilityMode;
  limits?: { dataScope?: string; rateLimitPerMin?: number; costCapUsd?: number; maxAmount?: number; argConstraints?: string };
};
export type Grant = { agent: string; scope: string; tools: string[] };
export type Conn = {
  id: string;
  name: string;
  type: string;
  template: string;
  connector: string;
  auth: 'oauth' | 'service';
  health: 'healthy' | 'needs-reconnect' | 'untested';
  dataUsage: 'bronze' | 'files' | null;
  /** How that data-source registration ran: 'offline-mock' (fabricated counts) vs 'live'. */
  dataUsageMode?: 'live' | 'offline-mock';
  endpoint: string;
  principal: string;
  owner: string;
  domain: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  /** Soft-archived (retained, reversible). */
  archived?: boolean;
  /** The folder this connection lives in (normalised path; `'/'` = root). */
  folder?: string;
  mode: string;
  secretRef: { name: string; key: string };
  secretSet: boolean;
  secretFingerprint: string;
  egress: { external: boolean; host: string; allowed: boolean };
  tools: Tool[];
  grants: Grant[];
  /** Only on a `warehouse` template: the non-secret federation config (platform + catalog). */
  warehouse?: { platform: string; catalog: string; config?: Record<string, string> };
};
export type Template = {
  key: string;
  label: string;
  type: string;
  connector: string;
  auth: 'oauth' | 'service';
  endpointHint: string;
};
export type OAuthProviderStatus = { provider: OAuthProvider; label: string; configured: boolean };
/** One external-warehouse provider's create metadata (fields render from this). */
export type WarehouseField = { key: string; label: string; required: boolean; help?: string; kind?: string };
export type WarehouseProviderMeta = {
  platform: string;
  label: string;
  capabilities: { federate: boolean; import: boolean; sync?: boolean };
  /** 'operational' (OLTP sync sources) | 'streaming' (Kafka) | null = warehouse. */
  category?: 'operational' | 'streaming' | null;
  credentialFields: WarehouseField[];
  secretKeys: string[];
  liveVerificationRequired: string[];
};
export type WarehouseMeta =
  | { enabled: false }
  | { enabled: true; template: Template; providers: WarehouseProviderMeta[] };
export type Data = {
  user: { id: string; role: Role; domains: string[] };
  connections: Conn[];
  templates: Template[];
  warehouse?: WarehouseMeta;
  canCreate: boolean;
  canCreatePersonal: boolean;
  oauthProviders?: OAuthProviderStatus[];
  /** OPERATIONAL_ACTIONS_ENABLED — gates the Phase-3 agent-action toggles (default off). */
  operationalActionsEnabled?: boolean;
};
export type ApprovalDiff = { field: string; before: unknown; after: unknown };
export type ApprovalPreview = {
  action: string;
  args: Record<string, unknown>;
  diff: ApprovalDiff[];
  who: string;
  reason: string;
};
export type EgressRequest = { id: string; host: string; reason: string; status: string; requestedBy?: string; at?: string };

export type AppTool = { name: string; description: string; write: boolean };
export type AppConn = {
  id: string;
  appId: string;
  appSlug: string;
  name: string;
  principal: string;
  owner: string;
  domain: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  tools: AppTool[];
};
export type AppConns = { connections: AppConn[] };

// ---- Vocabulary helpers ----------------------------------------------------

export function badge(v: string) { return `badge vis-${v.toLowerCase()}`; }
export function modeBadge(m: CapabilityMode) {
  if (m === 'Read') return 'badge ok';
  if (m === 'Write-bounded') return 'badge warn';
  if (m === 'Write-approval') return 'badge warn';
  if (m === 'Blocked') return 'badge err';
  return 'badge muted';
}

/** Connection visibility → the OS-wide lifecycle visibility (drives the delete gate). */
export const connVisibility = (v: Conn['visibility']): Visibility =>
  v === 'Shared' ? 'shared' : v === 'Certified' ? 'certified' : 'personal';

/** Display word for a connection's stored visibility. Mirrors lib/core/scopes.ts
 *  (source of truth): Personal→"My", Shared→"Domain", Certified→"Company". */
export const visWord = (v: Conn['visibility']): string =>
  v === 'Shared' ? 'Domain' : v === 'Certified' ? 'Company' : 'My';

/** Connection tier → the PromoteButton's ladder tier (Personal→Shared→Marketplace). */
export const ladderTier = (v: Conn['visibility']): 'Personal' | 'Shared' | 'Marketplace' =>
  v === 'Shared' ? 'Shared' : v === 'Certified' ? 'Marketplace' : 'Personal';

/**
 * Does this text look like a URL / hostname (not a pasted credential)? A calm client-side
 * shape check ONLY — the server stays the authority on egress/allowlist. We normalise a
 * bare host (add https://), then require a parseable URL with a dotted hostname. A pasted
 * API key (no scheme, no dot, often long/opaque) fails here, so we never ship it to the
 * egress path where the error would echo it back. Returns true for empty (the caller's
 * required-field guard handles blanks). */
export function looksLikeEndpoint(raw: string): boolean {
  const v = raw.trim();
  if (!v) return true;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    // A real host has a dot (api.example.com) or is localhost; a credential almost never does.
    return u.hostname === 'localhost' || u.hostname.includes('.');
  } catch { return false; }
}

/** The plain-language nudge shown when an endpoint field looks like a pasted credential. */
export const ENDPOINT_LOOKS_WRONG =
  "That doesn't look like a URL — did you paste a credential here? The API key goes in the next step.";

/**
 * If a template's `endpointHint` is a CONCRETE fixed endpoint (e.g. Kajabi → https://api.kajabi.com),
 * return it so the wizard can prefill the field — editable, but starting filled so nobody pastes a
 * credential into an empty box. Returns null for GENERIC/placeholder hints (example.com, <tokens>,
 * yourorg/your-site/host/tenant stand-ins, or non-URL notes) — those stay empty with the placeholder.
 */
export function fixedEndpointHint(hint: string | undefined): string | null {
  const v = (hint ?? '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) return null;            // not a plain http(s) URL (postgres://, notes)
  if (/example\.com|<|>|yourorg|your-site|\bhost\b|\btenant\b|999999/i.test(v)) return null; // placeholder
  try {
    const u = new URL(v);
    return u.hostname.includes('.') ? v : null;
  } catch { return null; }
}

/** Shared fetch helper — no side effects, usable anywhere. Returns ok + parsed body. */
export async function postJSON(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}
