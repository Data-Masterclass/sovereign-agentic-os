/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Shared audit record. EVERY Platform-Admin mutation funnels through `audit()`
 * — domain created, user invited/deactivated, model cap set, egress entry added,
 * restore triggered. The record is the same one Governance surfaces, so the two
 * tabs never keep separate logs: Platform Admin WRITES, Governance/Monitoring
 * READ.
 *
 * Store mirrors the artifact/approval pattern: an authoritative in-process ring
 * (works with no cluster) plus a best-effort OpenSearch write-through (`os-audit`)
 * for durability in a real deploy. Pure imports only (config) so it stays
 * unit-testable.
 */
import { osMirror } from '../infra/os-mirror.ts';

export type AuditResult = 'ok' | 'denied' | 'error';

export type AuditEntry = {
  id: string;
  ts: string;
  tenant: string;
  /** Who acted (user id). */
  actor: string;
  role: string;
  /** Machine action key, e.g. `domain.create`, `backups.restore`. */
  action: string;
  /** What it acted on, e.g. `domain:sales`. */
  target: string;
  detail: string;
  result: AuditResult;
  /** True when the action passed a typed-confirmation guard. */
  guarded?: boolean;
};

const RING_MAX = 500;
type AuditState = { ring: AuditEntry[]; hydration: Promise<void> | null };
const AUDIT_KEY = Symbol.for('soa.platform.audit');
function auditState(): AuditState {
  const g = globalThis as unknown as Record<symbol, AuditState | undefined>;
  if (!g[AUDIT_KEY]) g[AUDIT_KEY] = { ring: [], hydration: null };
  return g[AUDIT_KEY]!;
}

function id(): string {
  return `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Shared durable-mirror core (lib/os-mirror.ts): first write probes the cluster
// and CREATES the index when missing, so the audit trail persists on a fresh deploy.
const mirror = osMirror({ index: 'os-audit' });

export async function ensureHydrated(): Promise<void> {
  const s = auditState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = auditState();
  const docs = (await mirror.hydrate(500)) ?? [];
  // Sort chronologically (oldest first), then prepend to ring so newest ends up first.
  const sorted = (docs as AuditEntry[])
    .filter((e) => e && e.id)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  for (const e of sorted) {
    if (!s.ring.find((r) => r.id === e.id)) {
      // In-process entries are already at the front (unshift order). Append
      // historical entries at the back — ring stays newest-first for callers.
      s.ring.push(e);
    }
  }
  if (s.ring.length > RING_MAX) s.ring.length = RING_MAX;
}

function writeThrough(entry: AuditEntry): void {
  mirror.writeThrough(entry.id, entry);
}

/** Record one audited action. Returns the stored entry (id + ts filled). */
export function audit(input: {
  tenant: string;
  actor: string;
  role: string;
  action: string;
  target: string;
  detail: string;
  result?: AuditResult;
  guarded?: boolean;
}): AuditEntry {
  const entry: AuditEntry = {
    id: id(),
    ts: new Date().toISOString(),
    result: 'ok',
    ...input,
  };
  auditState().ring.unshift(entry);
  const r = auditState().ring; if (r.length > RING_MAX) r.length = RING_MAX;
  writeThrough(entry);
  return entry;
}

/** Most-recent-first audit feed, optionally filtered by action prefix. */
export function listAudit(opts: { limit?: number; prefix?: string } = {}): AuditEntry[] {
  const { limit = 100, prefix } = opts;
  const ring = auditState().ring;
  const rows = prefix ? ring.filter((e) => e.action.startsWith(prefix)) : ring;
  return rows.slice(0, limit);
}

/** Test seam: clear the in-process ring. */
export function _resetAudit(): void {
  const s = auditState();
  s.ring.length = 0;
  s.hydration = null;
  mirror.__reset();
}
