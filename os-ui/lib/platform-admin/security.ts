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
 * Pure store (the live source of truth is the egress proxy + OPA bundle);
 * unit-testable. Host normalization mirrors `lib/secrets.ts` egress logic.
 */

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
// read in another). Same pattern as lib/marketplace/store.ts.
const ALLOW_KEY = Symbol.for('soa.platform-admin.egress-allow');
function allow(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[ALLOW_KEY]) g[ALLOW_KEY] = new Set<string>(DEFAULT_ALLOW);
  return g[ALLOW_KEY]!;
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
  return h;
}

export function removeAllowlist(endpoint: string): string {
  const h = host(endpoint);
  allow().delete(h);
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
}
