/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';

/**
 * The Governance approval queue (golden path §6.5, §7). When a governed tool call
 * returns `requires_approval` — an external connection write, a knowledge
 * certify/publish, a file promotion — the action is PAUSED and a request lands
 * here with its trace + context. A Builder/Admin clears it in the Governance tab;
 * approval is one-time (or, later, promoted to a standing policy). Every decision
 * is attributed (agent key + approving human) and logged.
 *
 * Store: in-process (authoritative locally) with a best-effort OpenSearch
 * write-through so a real deploy is durable.
 */

export type ApprovalKind = 'connection_write' | 'knowledge_certify' | 'file_promote';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type Approval = {
  id: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  /** The agent identity (LiteLLM key) that requested the write. */
  agent: string;
  domain: string;
  /** Who initiated the run (human in the loop). */
  requestedBy: string;
  /** The tool the agent tried to call (for the audit trail). */
  tool: string;
  /** Opaque payload that will be applied on approval (e.g. the CRM patch). */
  payload: Record<string, unknown>;
  traceId?: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
};

const queue = new Map<string, Approval>();

function now(): string {
  return new Date().toISOString();
}
function id(): string {
  return `apr_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

async function writeThrough(a: Approval): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    await fetch(`${config.opensearchUrl}/os-approvals/_doc/${a.id}?refresh=true`, {
      method: 'PUT',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(a),
    });
  } catch {
    /* best-effort durable mirror */
  } finally {
    clearTimeout(timer);
  }
}

export function enqueue(input: {
  kind: ApprovalKind;
  title: string;
  detail: string;
  agent: string;
  domain: string;
  requestedBy: string;
  tool: string;
  payload?: Record<string, unknown>;
  traceId?: string;
}): Approval {
  const a: Approval = {
    id: id(),
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    agent: input.agent,
    domain: input.domain,
    requestedBy: input.requestedBy,
    tool: input.tool,
    payload: input.payload ?? {},
    traceId: input.traceId,
    status: 'pending',
    createdAt: now(),
  };
  queue.set(a.id, a);
  void writeThrough(a);
  return a;
}

export function listApprovals(opts: { domain?: string; status?: ApprovalStatus } = {}): Approval[] {
  return [...queue.values()]
    .filter((a) => (opts.domain ? a.domain === opts.domain : true))
    .filter((a) => (opts.status ? a.status === opts.status : true))
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

export function getApproval(approvalId: string): Approval | null {
  return queue.get(approvalId) ?? null;
}

/** A Builder/Admin clears a held action. Returns the updated record. */
export function decide(approvalId: string, decision: 'approve' | 'reject', by: string): Approval | null {
  const a = queue.get(approvalId);
  if (!a || a.status !== 'pending') return a ?? null;
  a.status = decision === 'approve' ? 'approved' : 'rejected';
  a.decidedBy = by;
  a.decidedAt = now();
  queue.set(a.id, a);
  void writeThrough(a);
  return a;
}

export function pendingCount(domain?: string): number {
  return listApprovals({ domain, status: 'pending' }).length;
}
