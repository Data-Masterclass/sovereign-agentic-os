/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Security & Egress adapter — the sovereign-posture board.
 *
 * - Egress allowlist: Admin-curated list of hosts the tenant may reach. Builders
 *   raise REQUESTS (cross-linked from Governance); the Admin approves → the host
 *   joins the allowlist and compiles into the OPA `egress_allow` resource +
 *   (in a real deploy) the egress proxy / Cilium FQDN policy.
 * - Read-only posture: secrets-manager status, data residency, OPA policy-bundle
 *   version, audit retention, certs/keys posture. These are surfaced, never
 *   editable as raw values, and NEVER include a secret.
 *
 * DURABILITY: the allowlist is the load-bearing state (it compiles into the OPA
 * `egress_allow` resource), so it is written THROUGH to the OpenSearch mirror
 * (`os-egress-allow`) and hydrated on boot — without this a pod roll reverted the
 * curated allowlist to the seed defaults while the audit row claimed the host was
 * allowlisted. One doc per host; a `__seeded__` marker records that the default
 * seed was already applied so a redeploy never resurrects a host an admin removed.
 * (The demo `requests` list is a transient UI surface — the durable egress-request
 * store is lib/connections/egress-requests.ts — so it is intentionally NOT mirrored.)
 * Host normalization mirrors `lib/secrets.ts` egress logic; unit-testable.
 */
import { osMirror } from '../infra/os-mirror.ts';

function host(endpoint: string): string {
  const raw = (endpoint || '').trim();
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.hostname.toLowerCase();
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
  }
}
function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

const DEFAULT_ALLOW = ['example.com', 'github.com', 'salesforce.com', 'notion.com'];

// Pinned to globalThis so the egress allowlist + requests are a TRUE singleton
// across separately-bundled App Router route handlers (approve in one route,
// read in another). Same pattern as lib/governance/approvals.ts.
const ALLOW_KEY = Symbol.for('soa.platform-admin.egress-allow');
function allow(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[ALLOW_KEY]) g[ALLOW_KEY] = new Set<string>(DEFAULT_ALLOW);
  return g[ALLOW_KEY]!;
}

// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/infra/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.
const mirror = osMirror({ index: 'os-egress-allow' });
const SEED_MARKER = '__seeded__';
const HYDRATION_KEY = Symbol.for('soa.platform-admin.egress-allow.hydration');
function hydrationState(): { p: Promise<void> | null } {
  const g = globalThis as unknown as Record<symbol, { p: Promise<void> | null } | undefined>;
  if (!g[HYDRATION_KEY]) g[HYDRATION_KEY] = { p: null };
  return g[HYDRATION_KEY]!;
}

/** One mirror doc id per host (hosts contain dots — encode them for the _doc path). */
function hostDocId(h: string): string {
  return `host_${h.replace(/[^a-z0-9]/gi, '_')}`;
}
function persistHost(h: string): void {
  mirror.writeThrough(hostDocId(h), { id: hostDocId(h), host: h });
}
function unpersistHost(h: string): void {
  mirror.deleteThrough(hostDocId(h));
}

/**
 * Hydrate the allowlist from the mirror once (best-effort). If the mirror already
 * holds docs (a prior run persisted the seed + any edits), the in-process Set is
 * REBUILT from them — so a host an admin removed stays removed across the roll. On
 * a genuinely fresh mirror the seed defaults are persisted once (marked) so the
 * next pod hydrates the same starting set. FAIL-SOFT: an unreachable mirror leaves
 * the in-memory defaults in place and never throws.
 */
export async function ensureHydrated(): Promise<void> {
  const st = hydrationState();
  if (!st.p) st.p = hydrateAllow();
  return st.p;
}

async function hydrateAllow(): Promise<void> {
  const docs = await mirror.hydrate(2000); // null → mirror down → keep in-memory defaults
  if (docs === null) return;
  const hosts = new Set<string>();
  let seeded = false;
  for (const d of docs as { id?: string; host?: string }[]) {
    if (d?.id === SEED_MARKER) { seeded = true; continue; }
    if (typeof d?.host === 'string' && d.host) hosts.add(d.host);
  }
  if (!seeded) {
    // Fresh mirror: persist today's seed once so future pods rebuild the same set.
    const a = allow();
    for (const h of a) persistHost(h);
    mirror.writeThrough(SEED_MARKER, { id: SEED_MARKER, seededAt: new Date().toISOString() });
    return;
  }
  const a = allow();
  a.clear();
  for (const h of hosts) a.add(h);
}

export type EgressRequest = {
  id: string;
  host: string;
  reason: string;
  requestedBy: string;
  domain: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
};

const REQUESTS_KEY = Symbol.for('soa.platform-admin.egress-requests');
function requests(): Map<string, EgressRequest> {
  const g = globalThis as unknown as Record<symbol, Map<string, EgressRequest> | undefined>;
  if (!g[REQUESTS_KEY]) {
    g[REQUESTS_KEY] = new Map<string, EgressRequest>([
      [
        'egr_demo',
        {
          id: 'egr_demo',
          host: 'api.openai.com',
          reason: 'External model fallback for the Sales agent',
          requestedBy: 'bea',
          domain: 'sales',
          status: 'pending',
          createdAt: '2026-06-20T09:00:00.000Z',
        },
      ],
    ]);
  }
  return g[REQUESTS_KEY]!;
}

export function listAllowlist(): string[] {
  return [...allow()].sort();
}

export function addAllowlist(endpoint: string): string {
  const h = host(endpoint);
  if (!h || !h.includes('.')) throw fail('Enter a valid external host (e.g. api.example.com)', 400);
  allow().add(h);
  persistHost(h);
  return h;
}

export function removeAllowlist(endpoint: string): string {
  const h = host(endpoint);
  allow().delete(h);
  unpersistHost(h);
  return h;
}

export function listRequests(): EgressRequest[] {
  return [...requests().values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Approve a Builder's egress request → its host joins the allowlist. */
export function decideRequest(id: string, decision: 'approved' | 'rejected'): { request: EgressRequest; host?: string } {
  const r = requests().get(id);
  if (!r) throw fail('Request not found', 404);
  r.status = decision;
  if (decision === 'approved') {
    allow().add(r.host);
    persistHost(r.host);
    return { request: r, host: r.host };
  }
  return { request: r };
}

export type SecurityPosture = {
  residency: string;
  secretsManager: { backend: string; status: 'healthy' | 'degraded'; secretsStored: number };
  opaBundle: { version: string; lastCompiled: string };
  auditRetentionDays: number;
  certs: { issuer: string; status: 'valid' | 'expiring' | 'expired'; daysToExpiry: number };
  egressProxy: { enabled: boolean; allowlistSize: number };
};

/** Read-only sovereign posture. `secretsStored`/`opaBundle` are injected by the
 * route (which can see the secrets vault + compiled bundle); residency/certs are
 * tenant config. Never includes a secret value. */
export function posture(input: {
  residency: string;
  secretsStored: number;
  opaBundleVersion: string;
  opaLastCompiled: string;
  auditRetentionDays: number;
}): SecurityPosture {
  return {
    residency: input.residency,
    secretsManager: {
      backend: 'STACKIT Secrets Manager (External Secrets)',
      status: 'healthy',
      secretsStored: input.secretsStored,
    },
    opaBundle: { version: input.opaBundleVersion, lastCompiled: input.opaLastCompiled },
    auditRetentionDays: input.auditRetentionDays,
    certs: { issuer: 'cert-manager / Let’s Encrypt', status: 'valid', daysToExpiry: 78 },
    egressProxy: { enabled: true, allowlistSize: allow().size },
  };
}

export function _reset(): void {
  const a = allow();
  a.clear();
  for (const h of DEFAULT_ALLOW) a.add(h);
  hydrationState().p = null;
  mirror.__reset();
}
