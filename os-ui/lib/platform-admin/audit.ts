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
import { config } from '../config.ts';

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
const ring: AuditEntry[] = [];

function id(): string {
  return `aud_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function writeThrough(entry: AuditEntry): void {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  void fetch(`${config.opensearchUrl}/os-audit/_doc/${entry.id}?refresh=true`, {
    method: 'PUT',
    signal: ctrl.signal,
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
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
  ring.unshift(entry);
  if (ring.length > RING_MAX) ring.length = RING_MAX;
  writeThrough(entry);
  return entry;
}

/** Most-recent-first audit feed, optionally filtered by action prefix. */
export function listAudit(opts: { limit?: number; prefix?: string } = {}): AuditEntry[] {
  const { limit = 100, prefix } = opts;
  const rows = prefix ? ring.filter((e) => e.action.startsWith(prefix)) : ring;
  return rows.slice(0, limit);
}

/** Test seam: clear the in-process ring. */
export function _resetAudit(): void {
  ring.length = 0;
}
