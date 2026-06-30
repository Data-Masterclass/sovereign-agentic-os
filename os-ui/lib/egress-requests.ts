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

const REQUESTS = new Map<string, EgressRequest>();
const APPROVED = new Set<string>(); // approved hostnames (lowercased)
const LOG: EgressLogEntry[] = [];
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
  REQUESTS.set(r.id, r);
  return r;
}

/** An Admin decides a request; approving adds the host to the allowlist. */
export function decideEgress(id: string, decision: 'approve' | 'reject', by: string): EgressRequest | null {
  const r = REQUESTS.get(id);
  if (!r || r.status !== 'pending') return r ?? null;
  r.status = decision === 'approve' ? 'approved' : 'rejected';
  r.decidedBy = by;
  r.decidedAt = new Date().toISOString();
  if (r.status === 'approved') APPROVED.add(r.host);
  REQUESTS.set(r.id, r);
  return r;
}

/** Is this host Admin-approved for egress (in addition to the static allowlist)? */
export function isHostApproved(host: string): boolean {
  const h = norm(host);
  return APPROVED.has(h) || [...APPROVED].some((d) => h === d || h.endsWith(`.${d}`));
}

export function listEgressRequests(opts: { domain?: string; status?: EgressStatus } = {}): EgressRequest[] {
  return [...REQUESTS.values()]
    .filter((r) => (opts.domain ? r.domain === opts.domain : true))
    .filter((r) => (opts.status ? r.status === opts.status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Record an outbound call (monitored egress). */
export function logEgress(entry: { host: string; connectionId?: string; tool?: string }): void {
  LOG.push({ ...entry, host: norm(entry.host), at: new Date().toISOString() });
  if (LOG.length > LOG_MAX) LOG.splice(0, LOG.length - LOG_MAX);
}
export function egressLog(limit = 50): EgressLogEntry[] {
  return LOG.slice(-limit).reverse();
}
export function _clearEgress(): void {
  REQUESTS.clear();
  APPROVED.clear();
  LOG.length = 0;
}
