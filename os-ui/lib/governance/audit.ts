/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { config } from '../config.ts';

/**
 * Audit integrity (governance-golden-path.md §3) — the trustworthy record of
 * WHO did/approved WHAT, WHEN, and on WHICH inputs. Every governed effect,
 * policy override, cost cap and role change appends one entry here. The log is
 * the authoritative in-process record (so it works with no cluster) and is
 * mirrored best-effort to Langfuse so it joins agent-run traces + OpenMetadata
 * lineage in the same observability plane.
 *
 * Integrity: entries are append-only and hash-chained — each carries the hash of
 * the previous entry, so a tampered/removed record breaks the chain and
 * `verifyChain()` flags it. Pure + testable; the Langfuse mirror is isolated.
 */

export type AuditAction =
  | 'approve'
  | 'deny'
  | 'policy.override'
  | 'cost.cap.set'
  | 'role.change'
  | 'access.grant'
  | 'egress.allow'
  | 'deploy';

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

async function mirrorToLangfuse(e: AuditEntry): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const auth =
      'Basic ' +
      Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
    await fetch(`${config.langfuseUrl}/api/public/ingestion`, {
      method: 'POST',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({
        batch: [
          {
            id: e.id,
            type: 'trace-create',
            timestamp: e.at,
            body: {
              id: e.id,
              name: `governance.${e.action}`,
              metadata: { actor: e.actor, domain: e.domain, subject: e.subject },
              input: e.detail,
              output: { reason: e.reason },
              tags: ['governance', `action:${e.action}`],
            },
          },
        ],
      }),
    });
  } catch {
    /* best-effort durable mirror */
  } finally {
    clearTimeout(timer);
  }
}

/** Append an audit entry (hash-chained) + mirror to Langfuse. Returns it. */
export function record(input: {
  actor: string;
  action: AuditAction;
  subject: string;
  domain: string;
  reason: string;
  detail?: Record<string, unknown>;
}): AuditEntry {
  const prev = log[log.length - 1];
  const prevHash = prev ? prev.hash : '00000000';
  const at = now();
  const id = `aud_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
  const detail = input.detail ?? {};
  const body = JSON.stringify({
    id,
    at,
    actor: input.actor,
    action: input.action,
    subject: input.subject,
    domain: input.domain,
    reason: input.reason,
    detail,
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
    prevHash,
    hash: hashOf(body),
  };
  log.push(e);
  void mirrorToLangfuse(e);
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
