/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '@/lib/os-mirror';

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

/**
 * The unified Governance approval queue. The first kinds are the original
 * agent write-backs (held by the governed-tool spine: connection writes,
 * knowledge certify, file/dataset promotion + certification, app deploy,
 * marketplace import); the rest are the async Governance sources consolidated by
 * the control plane (governance-golden-path.md §1): a Software deploy-review, an
 * autonomous out-of-policy action, an access/import request, an egress endpoint
 * request, a promote/certify. Inline (attended) write-approvals stay in the run
 * and do NOT land here.
 */
export type ApprovalKind =
  | 'connection_write'
  | 'knowledge_certify'
  | 'file_promote'
  | 'dataset_promote'
  | 'dataset_certify'
  | 'app_deploy'
  | 'marketplace_import'
  | 'deploy_review'
  | 'autonomous_out_of_policy'
  | 'access_request'
  | 'egress_request'
  // Rung-1 promotion (Personal→Domain) for the ladder kinds that were formerly
  // one-step DIRECT (knowledge/connection/model/artifact/dashboard/app). The
  // payload carries `{ artifactKind, id }`; the effect dispatches per-kind.
  | 'artifact_promote'
  // Rung-2 certification (Domain→Marketplace) for EVERY kind — admin-approved.
  | 'promote_certify';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** Who must clear the item. Egress + tenant defaults are Admin-only. */
export type ApproverRole = 'builder' | 'admin';
/** Visibility/decision scope: own request, a domain, or the whole tenant. */
export type ApprovalScope = 'own' | 'domain' | 'tenant';

/** The full card preview the inbox renders (what · who · why · impact). */
export type ApprovalPreview = {
  what: string;
  who: string;
  why: string;
  impact: string;
  /** Software deploy-review extras (scan · resources · cost · diff). */
  scan?: string;
  resources?: string;
  cost?: string;
  diff?: string;
};

export type Approval = {
  id: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  /** The agent identity (LiteLLM key) or actor that requested the action. */
  agent: string;
  domain: string;
  /** Who initiated the run / raised the request (human in the loop). */
  requestedBy: string;
  /** The tool/effect the action maps to (for the audit trail). */
  tool: string;
  /** Opaque payload applied on approval (e.g. CRM patch, endpoint, grant). */
  payload: Record<string, unknown>;
  /** Min role to clear it (default builder; egress/tenant → admin). */
  approverRole: ApproverRole;
  /** Decision scope (default domain). `tenant` items are Admin-only. */
  scope: ApprovalScope;
  /** Whether "approve & remember" (→ standing policy) is offered. */
  rememberable: boolean;
  /** Originating surface, for the audit narrative ("Software", "Agents", …). */
  source: string;
  preview?: ApprovalPreview;
  traceId?: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  /** What the approval actually did (set once the effect runs). */
  effect?: ApprovalEffect;
  createdAt: string;
};

/** The recorded outcome of an approval's executed effect. `publish` carries the
 *  physical dataset-publish result (T8) so the PromotePanel / Governance card can
 *  show live | failed honestly instead of string-matching the summary. */
export type ApprovalEffect = {
  applied: string;
  live: boolean;
  standingPolicyId?: string;
  publish?: { ok: boolean; fqn: string; error?: string; mode?: string; cubeView?: string | null };
};

// Pinned to globalThis so the queue is a TRUE singleton across separately
// bundled Next.js route handlers (the marketplace import route enqueues; the
// governance route reads) and survives dev HMR.
type ApprovalsState = { queue: Map<string, Approval>; hydration: Promise<void> | null };
const QUEUE_KEY = Symbol.for('soa.approvals.queue');
function approvalsState(): ApprovalsState {
  const g = globalThis as unknown as Record<symbol, ApprovalsState | undefined>;
  if (!g[QUEUE_KEY]) g[QUEUE_KEY] = { queue: new Map(), hydration: null };
  return g[QUEUE_KEY]!;
}
function queueMap(): Map<string, Approval> {
  return approvalsState().queue;
}
const queue = { get: (k: string) => queueMap().get(k), set: (k: string, v: Approval) => queueMap().set(k, v), values: () => queueMap().values(), clear: () => queueMap().clear() };

function now(): string {
  return new Date().toISOString();
}
function id(): string {
  return `apr_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

// Shared durable-mirror core (lib/os-mirror.ts): first write probes the cluster
// and CREATES the index when missing, so approvals stay durable on a fresh deploy.
const mirror = osMirror({ index: 'os-approvals' });

export async function ensureHydrated(): Promise<void> {
  const s = approvalsState();
  if (!s.hydration) s.hydration = hydrate();
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = approvalsState();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const a of docs as Approval[]) {
    // Don't clobber any approval created in-process before hydration completed.
    if (a && a.id && !s.queue.has(a.id)) s.queue.set(a.id, a);
  }
}

async function writeThrough(a: Approval): Promise<void> {
  mirror.writeThrough(a.id, a); // best-effort durable mirror
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
  approverRole?: ApproverRole;
  scope?: ApprovalScope;
  rememberable?: boolean;
  source?: string;
  preview?: ApprovalPreview;
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
    approverRole: input.approverRole ?? 'builder',
    scope: input.scope ?? 'domain',
    rememberable: input.rememberable ?? false,
    source: input.source ?? 'Governance',
    preview: input.preview,
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
  // Return null unless we ACTUALLY transition a pending item — so a racing
  // second approver can't re-run the governed effect on an already-decided item.
  if (!a || a.status !== 'pending') return null;
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

/** Stamp what the approval actually did (the executed effect), for the card + audit. */
export function recordEffect(
  approvalId: string,
  effect: ApprovalEffect,
): Approval | null {
  const a = queue.get(approvalId);
  if (!a) return null;
  a.effect = effect;
  queue.set(a.id, a);
  void writeThrough(a);
  return a;
}

/** Test-only: drop the in-process queue so each test starts clean. */
export function __resetApprovals(): void {
  const s = approvalsState();
  s.queue.clear();
  s.hydration = null;
  mirror.__reset();
}
