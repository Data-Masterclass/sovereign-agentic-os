/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Egress governance — Builder-request → Admin-approve for a NEW endpoint
 * (Connections golden path "egress", security.md). Outbound is DEFAULT-DENY: an
 * Admin pre-curates the allowlist (`lib/secrets.ts`), and for an endpoint not yet
 * on it a Builder REQUESTS access and an Admin APPROVES. Approved hosts then pass
 * the egress check; every outbound call is LOGGED. PURE module (no server-only):
 * `lib/secrets.ts` consults `isHostApproved`, routes wire request/approve, and the
 * connection tool path appends to the egress log. The live source of truth in a
 * deploy is the egress proxy + Cilium FQDN policy; this mirror makes the
 * request→approve→logged flow demonstrable in kind.
 */

import { osMirror } from './os-mirror.ts';

export type EgressStatus = 'pending' | 'approved' | 'rejected';

export type EgressRequest = {
  id: string;
  host: string;
  domain: string;
  reason: string;
  requestedBy: string;
  status: EgressStatus;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
};

export type EgressLogEntry = {
  host: string;
  connectionId?: string;
  tool?: string;
  at: string;
};

type EgressState = { requests: Map<string, EgressRequest>; approved: Set<string>; log: EgressLogEntry[]; hydration: Promise<void> | null };
const EGRESS_KEY = Symbol.for('soa.egress.requests');
function egressState(): EgressState {
  const g = globalThis as unknown as Record<symbol, EgressState | undefined>;
  if (!g[EGRESS_KEY]) g[EGRESS_KEY] = { requests: new Map(), approved: new Set(), log: [], hydration: null };
  return g[EGRESS_KEY]!;
}

// ---------------------------------------------------- durable mirror (best-effort) --
const mirror = osMirror({
  index: 'os-egress-requests',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        host: { type: 'keyword' },
        domain: { type: 'keyword' },
        requestedBy: { type: 'keyword' },
        status: { type: 'keyword' },
        decidedBy: { type: 'keyword' },
        createdAt: { type: 'date' },
        decidedAt: { type: 'date' },
        reason: { type: 'text', index: false },
      },
    },
  },
});

function writeThrough(r: EgressRequest): void {
  mirror.writeThrough(r.id, r);
}

export async function ensureHydrated(): Promise<void> {
  const s = egressState();
  if (!s.hydration) s.hydration = hydrateEgress();
  return s.hydration;
}

async function hydrateEgress(): Promise<void> {
  const s = egressState();
  const docs = (await mirror.hydrate(1000)) ?? [];
  for (const r of docs as EgressRequest[]) {
    if (r && r.id && !s.requests.has(r.id)) {
      s.requests.set(r.id, r);
      if (r.status === 'approved' && r.host) s.approved.add(r.host);
    }
  }
}
const LOG_MAX = 200;

function rid(): string {
  return `egr_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
function norm(host: string): string {
  return (host || '').trim().toLowerCase();
}

/** A Builder requests egress to a new endpoint host. */
export function requestEgress(input: { host: string; domain: string; reason: string; requestedBy: string }): EgressRequest {
  const host = norm(input.host);
  const r: EgressRequest = {
    id: rid(),
    host,
    domain: input.domain,
    reason: input.reason,
    requestedBy: input.requestedBy,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  egressState().requests.set(r.id, r);
  writeThrough(r);
  return r;
}

/** An Admin decides a request; approving adds the host to the allowlist. */
export function decideEgress(id: string, decision: 'approve' | 'reject', by: string): EgressRequest | null {
  const r = egressState().requests.get(id);
  if (!r || r.status !== 'pending') return r ?? null;
  r.status = decision === 'approve' ? 'approved' : 'rejected';
  r.decidedBy = by;
  r.decidedAt = new Date().toISOString();
  if (r.status === 'approved') egressState().approved.add(r.host);
  egressState().requests.set(r.id, r);
  writeThrough(r);
  return r;
}

/** Is this host Admin-approved for egress (in addition to the static allowlist)? */
export function isHostApproved(host: string): boolean {
  const h = norm(host);
  return egressState().approved.has(h) || [...egressState().approved].some((d) => h === d || h.endsWith(`.${d}`));
}

export function listEgressRequests(opts: { domain?: string; status?: EgressStatus } = {}): EgressRequest[] {
  return [...egressState().requests.values()]
    .filter((r) => (opts.domain ? r.domain === opts.domain : true))
    .filter((r) => (opts.status ? r.status === opts.status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Record an outbound call (monitored egress). */
export function logEgress(entry: { host: string; connectionId?: string; tool?: string }): void {
  egressState().log.push({ ...entry, host: norm(entry.host), at: new Date().toISOString() });
  if (egressState().log.length > LOG_MAX) egressState().log.splice(0, egressState().log.length - LOG_MAX);
}
export function egressLog(limit = 50): EgressLogEntry[] {
  return egressState().log.slice(-limit).reverse();
}
export function _clearEgress(): void {
  const s = egressState();
  s.requests.clear();
  s.approved.clear();
  s.log.length = 0;
  s.hydration = null;
  mirror.__reset();
}

export function __resetEgress(): void {
  _clearEgress();
}
