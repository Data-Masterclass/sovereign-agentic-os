/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { audit as persistAudit } from '@tabs/admin/lib/audit';

/**
 * Audit integrity (governance-golden-path.md §3) — the trustworthy record of
 * WHO did/approved WHAT, WHEN, and on WHICH inputs. Every governed effect,
 * policy override, cost cap and role change appends one entry here.
 *
 * CONSOLIDATED store: this module keeps a hash-chained integrity view (so the
 * Governance "Audit" tab can prove tamper-evidence), but it is NOT a parallel
 * durable log. Every `record()` also WRITE-THROUGHs into the persistent Admin
 * audit store (lib/platform-admin/audit.ts → an os-audit ring + durable mirror
 * that hydrates on restart). Platform Admin and Governance therefore read ONE
 * durable, restart-surviving trail; nothing is silently dropped on a restart.
 * The audit trail lives in the OS audit store only: Langfuse holds traces, not audit
 * records (it has no retention or access control in OSS; design 05 W6).
 *
 * Integrity: entries are append-only and hash-chained — each carries the hash of
 * the previous entry, so a tampered/removed record breaks the chain and
 * `verifyChain()` flags it. Pure + testable.
 */

export type AuditAction =
  | 'approve'
  | 'deny'
  /** A requester took back their own agent run's held call before anyone decided it. */
  | 'approval.withdraw'
  | 'policy.override'
  | 'cost.cap.set'
  | 'role.change'
  | 'access.grant'
  | 'egress.allow'
  | 'deploy'
  /** The one-time move of an agent system onto a random, budgeted model key (make-before-break). */
  | 'gateway.key.migrate';

export type AuditEntry = {
  id: string;
  at: string;
  /** Who performed/approved it. */
  actor: string;
  action: AuditAction;
  /** What it acted on (app, grant, endpoint, user…). */
  subject: string;
  domain: string;
  /** Why / on which inputs (free text + structured detail). */
  reason: string;
  detail: Record<string, unknown>;
  /** The OPA `decision_id` this effect was enforced on, when an OPA decision gated it.
   *  It names the matching line in OPA's decision log (04 M1). */
  decisionId?: string;
  /** The OPA policy revision (`labels.policy_rev`) that made that decision. */
  policyRev?: string;
  /** Hash of the previous entry — the tamper-evident chain. */
  prevHash: string;
  hash: string;
};

const log: AuditEntry[] = [];

function now(): string {
  return new Date().toISOString();
}

/** Tiny non-crypto FNV-1a hash — enough to make tampering evident in-cluster. */
function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Append an audit entry (hash-chained) and write it through to the durable Admin store. Returns it. */
export function record(input: {
  actor: string;
  action: AuditAction;
  subject: string;
  domain: string;
  reason: string;
  detail?: Record<string, unknown>;
  /** From the OPA decision that gated this effect (`Authz.decisionId` / `policyRev`). */
  decisionId?: string;
  policyRev?: string;
}): AuditEntry {
  const prev = log[log.length - 1];
  const prevHash = prev ? prev.hash : '00000000';
  const at = now();
  const id = `aud_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
  const detail = input.detail ?? {};
  // Only present when an OPA decision gated the effect, so older entries hash unchanged.
  const opa = {
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
    ...(input.policyRev ? { policyRev: input.policyRev } : {}),
  };
  const body = JSON.stringify({
    id,
    at,
    actor: input.actor,
    action: input.action,
    subject: input.subject,
    domain: input.domain,
    reason: input.reason,
    detail,
    ...opa,
    prevHash,
  });
  const e: AuditEntry = {
    id,
    at,
    actor: input.actor,
    action: input.action,
    subject: input.subject,
    domain: input.domain,
    reason: input.reason,
    detail,
    ...opa,
    prevHash,
    hash: hashOf(body),
  };
  log.push(e);
  // Write-through into the persistent Admin store so this event survives a
  // restart and joins the ONE durable trail both tabs read. The Governance shape
  // (actor/action/subject/domain/reason) maps onto the Admin shape; the domain is
  // preserved in `detail` (parseable prefix) so Builder domain-scoping still works.
  try {
    persistAudit({
      tenant: 'tenant',
      actor: input.actor,
      role: '',
      action: `governance.${input.action}`,
      target: input.subject,
      detail: `[domain:${input.domain}] ${input.reason}`,
      // The structured detail and the OPA decision it was enforced on, durably: this store is
      // the one Governance reads after a restart (the in-process chain above is not).
      data: detail,
      ...opa,
    });
  } catch {
    /* never let a mirror failure break the governed action */
  }
  return e;
}

/** Searchable, filterable record (newest first). */
export function search(opts: {
  q?: string;
  actor?: string;
  action?: AuditAction;
  domain?: string;
  /** Restrict to these domains (Builder scope); omit for tenant-wide (Admin). */
  domains?: string[];
} = {}): AuditEntry[] {
  const q = opts.q?.trim().toLowerCase();
  return [...log]
    .reverse()
    .filter((e) => (opts.actor ? e.actor === opts.actor : true))
    .filter((e) => (opts.action ? e.action === opts.action : true))
    .filter((e) => (opts.domain ? e.domain === opts.domain : true))
    .filter((e) => (opts.domains ? opts.domains.includes(e.domain) : true))
    .filter((e) =>
      q
        ? `${e.actor} ${e.action} ${e.subject} ${e.reason} ${JSON.stringify(e.detail)}`
            .toLowerCase()
            .includes(q)
        : true,
    );
}

/** Re-walk the chain; returns the first broken entry id, or null if intact. */
export function verifyChain(): string | null {
  let prevHash = '00000000';
  for (const e of log) {
    if (e.prevHash !== prevHash) return e.id;
    const body = JSON.stringify({
      id: e.id,
      at: e.at,
      actor: e.actor,
      action: e.action,
      subject: e.subject,
      domain: e.domain,
      reason: e.reason,
      detail: e.detail,
      ...(e.decisionId ? { decisionId: e.decisionId } : {}),
      ...(e.policyRev ? { policyRev: e.policyRev } : {}),
      prevHash: e.prevHash,
    });
    if (hashOf(body) !== e.hash) return e.id;
    prevHash = e.hash;
  }
  return null;
}

/** Test-only: clear the log. */
export function __resetAudit(): void {
  log.length = 0;
}
