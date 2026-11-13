/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Governance approval queue — held actions, decisions, and (A2) the run they park
 * USER STORY: As a decider I want every held action in one inbox; as the agent engine I want a held
 *             write to be ONE approval record that remembers which run thread it parked, so the
 *             decision can resume that thread — without the kernel knowing the Agents tab exists.
 * ARCHITECTURE:
 *   - In-process singleton queue (globalThis-pinned) with a best-effort OpenSearch write-through.
 *   - A2: `enqueueOnce` is idempotent on `interruptKey` (= `<threadId>:<callId>`), because LangGraph
 *     re-runs an interrupted node from its start on every resume. `decide()` fires the registered
 *     `onDecided` handlers for an approval that carries a `runId`; the Agents tab registers the
 *     handler at boot (`tabs/agents/lib/engine/resume-boot.ts`) — a registration, never an import,
 *     so `core/policy` stays independent of its tabs. `decisionSettled(id)` lets a route or a test
 *     await the handlers; `recordResume` stamps what the resume did on the record.
 */
import 'server-only';
import { osMirror } from '@core/infra/os-mirror';
import type { Role } from '@core/kernel/session';

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
 * knowledge certify, file/dataset promotion + certification, app deploy); the
 * rest are the async Governance sources consolidated by
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
  | 'deploy_review'
  | 'autonomous_out_of_policy'
  | 'access_request'
  | 'egress_request'
  // Operational-connection write-action ENABLEMENT (operational-system-connections.md,
  // Phase 3): adding/broadening create/update on an exposure's `actions` holds the
  // WRITE scopes until an Admin approves. Read/search activate immediately; the
  // effect flips the exposure's `writeApproved` so the write tools compile. Approver
  // `admin`, tenant scope.
  | 'exposure_action_enable'
  // Rung-1 promotion (Personal→Domain) for the ladder kinds that were formerly
  // one-step DIRECT (knowledge/connection/model/artifact/dashboard/app). The
  // payload carries `{ artifactKind, id }`; the effect dispatches per-kind.
  | 'artifact_promote'
  // Rung-2 certification (Domain→Marketplace) for EVERY kind — admin-approved.
  | 'promote_certify';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** Who must clear the item. Personal→Shared promotions need a domain_admin;
 *  egress + tenant defaults are Admin-only; runtime write-approvals stay builder. */
export type ApproverRole = 'builder' | 'domain_admin' | 'admin';
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

/** The runner's identity snapshot an agent-run approval carries — the principal the RESUME runs as
 *  (role re-read live at resume time; this is what was true when the run parked). */
export type ApprovalRunner = { id: string; role: Role; domains: string[] };

/** What the resume after a decision did (A2). */
export type ApprovalResume = {
  /** `parked`: the run resumed and parked again on ANOTHER held call (A2 review L-F). */
  status: 'started' | 'done' | 'parked' | 'refused' | 'failed';
  at: string;
  /** Typed refusal/failure (`runner_unavailable`, `runner_role_insufficient`, `run_not_found`, …). */
  error?: { code: string; reason: string };
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
  // --- A2: an approval raised by a PARKED agent run (LangGraph `interrupt()`) carries its thread ---
  /** The run id (= LangGraph thread id) the decision resumes. Absent on every other approval. */
  runId?: string;
  /** The checkpointer thread id (today always = runId; kept separate for a future sub-graph namespace). */
  threadId?: string;
  /** Idempotency key `<threadId>:<callId>` — one approval per held tool call, however often the node re-runs. */
  interruptKey?: string;
  /** The agent system the run belongs to, and the agent node that made the call. */
  systemId?: string;
  node?: string;
  /** The runner's principal snapshot — the approver AUTHORISES, the runner EXECUTES. */
  runner?: ApprovalRunner;
  /** The tool call's arguments (bounded), so the card can show what will run. */
  args?: Record<string, unknown>;
  /** What the resume after the decision did. */
  resume?: ApprovalResume;
};

/** The recorded outcome of an approval's executed effect. `publish` carries the
 *  physical dataset-publish result (T8) so the PromotePanel / Governance card can
 *  show live | failed honestly instead of string-matching the summary. */
export type ApprovalEffect = {
  applied: string;
  live: boolean;
  standingPolicyId?: string;
  publish?: { ok: boolean; fqn: string; error?: string; mode?: string };
};

// Pinned to globalThis so the queue is a TRUE singleton across separately
// bundled Next.js route handlers (one route enqueues; the governance route
// reads) and survives dev HMR.
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
  runId?: string;
  threadId?: string;
  interruptKey?: string;
  systemId?: string;
  node?: string;
  runner?: ApprovalRunner;
  args?: Record<string, unknown>;
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
    runId: input.runId,
    threadId: input.threadId,
    interruptKey: input.interruptKey,
    systemId: input.systemId,
    node: input.node,
    runner: input.runner,
    args: input.args,
  };
  queue.set(a.id, a);
  void writeThrough(a);
  return a;
}

/**
 * Enqueue ONCE per `interruptKey` (A2). LangGraph re-runs an interrupted node from its start on
 * every resume, so the same held call asks again; the first record wins (whatever its status)
 * and `created` says whether this call made it. Requires `interruptKey`.
 */
export function enqueueOnce(input: Parameters<typeof enqueue>[0] & { interruptKey: string }): { approval: Approval; created: boolean } {
  const key = input.interruptKey;
  for (const a of queue.values()) {
    if (a.interruptKey === key) return { approval: a, created: false };
  }
  return { approval: enqueue(input), created: true };
}

/** A registered post-decision handler (A2): called once per decided approval that carries a `runId`. */
export type DecidedHandler = (approval: Approval, decision: 'approve' | 'reject') => Promise<void> | void;

type HookState = { handlers: Set<DecidedHandler>; settled: Map<string, Promise<void>> };
const HOOK_KEY = Symbol.for('soa.approvals.decided-hooks');
function hookState(): HookState {
  const g = globalThis as unknown as Record<symbol, HookState | undefined>;
  if (!g[HOOK_KEY]) g[HOOK_KEY] = { handlers: new Set(), settled: new Map() };
  return g[HOOK_KEY]!;
}

/**
 * Register a handler that runs after `decide()` transitions an approval carrying a `runId`.
 * The Agents tab registers the graph-resume here at boot — the kernel never imports the tab.
 * Returns the unregister function.
 */
export function onDecided(handler: DecidedHandler): () => void {
  const h = hookState().handlers;
  h.add(handler);
  return () => { h.delete(handler); };
}

/** Await the post-decision handlers of one approval (resolves at once when none ran). Never rejects. */
export function decisionSettled(approvalId: string): Promise<void> {
  return hookState().settled.get(approvalId) ?? Promise.resolve();
}

function fireDecided(a: Approval, decision: 'approve' | 'reject'): void {
  const st = hookState();
  if (!a.runId) return;
  if (st.handlers.size === 0) {
    // A2 review L-C: a process that never registered the resume (a worker without the boot
    // registration) must leave a trace on the card instead of a decided-but-never-resumed run.
    recordResume(a.id, { status: 'failed', at: now(), error: { code: 'resume_hook_unregistered', reason: 'no resume handler is registered in this process — the run was not resumed' } });
    return;
  }
  const runs = [...st.handlers].map(async (h) => {
    try {
      await h(a, decision);
    } catch (e) {
      // A handler failure must never undo the decision; it is stamped on the record for the card.
      recordResume(a.id, { status: 'failed', at: now(), error: { code: 'resume_handler_failed', reason: (e as Error).message } });
    }
  });
  st.settled.set(a.id, Promise.all(runs).then(() => undefined));
}

/** Stamp what the post-decision resume did (A2), for the card + audit. */
export function recordResume(approvalId: string, resume: ApprovalResume): Approval | null {
  const a = queue.get(approvalId);
  if (!a) return null;
  a.resume = resume;
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
  // A2: exactly one transition → exactly one resume. A racing second decider got `null` above.
  fireDecided(a, decision);
  return a;
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
  hookState().settled.clear();
  mirror.__reset();
}

/**
 * Test-only: simulate a POD RESTART — the in-process queue and its hydration promise are gone, the
 * durable mirror is untouched. The next `ensureHydrated()` must rebuild the queue from the mirror.
 */
export function __simulateRestart(): void {
  const s = approvalsState();
  s.queue.clear();
  s.hydration = null;
  hookState().settled.clear();
}

/** Test-only: drop every registered post-decision handler. */
export function __resetDecidedHandlers(): void {
  hookState().handlers.clear();
}
