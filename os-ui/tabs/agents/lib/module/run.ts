/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Drive one run of a module graph: start, park on approvals, resume by interrupt id
 * USER STORY: As the worker I want to run the team's committed `graph.mjs` exactly like the WP-26
 *             engine runs today's graph — one approval card per paused write however often the
 *             worker restarts, a decision that names a stale interrupt refused, the run resumable
 *             only for its owner — so switching a system to its module changes what runs, not how
 *             approvals behave.
 * ARCHITECTURE:
 *   - `graph.stream(input | Command({ resume: { [interruptId]: decision } }), { configurable:
 *     { thread_id: runId }, streamMode: 'updates', durability: 'sync', recursionLimit })`.
 *     `durability: 'sync'` awaits each checkpoint before the next step (the WP-26 finding).
 *   - Each `__interrupt__` (the stock HITL's `tool_approval` request, one per held call) becomes
 *     ONE card: `approvals.enqueueOnce({ interruptKey: '<thread>:<interruptId>' })`. LangGraph keeps
 *     the id stable across re-runs, so a replay never files a second card. Approver role and reason
 *     come from the request's `description` (`os-agent.ts` `osApprovals`).
 *   - OWNER + ENGINE STAMP: OS metadata, so it lives in the OS's own table, not in graph state:
 *     `agent_module_runs` (thread id → owner, module digest, commit), written once at start. A
 *     resume must find the stamp with the same owner (`ResumeNotFoundError`, 404) and name a
 *     pending interrupt (`StaleResumeError`, 409) — checked against `getState()` before anything
 *     runs. A thread with no stamp was started by the v1 engine and resumes there (the WP-26
 *     "engine stamped at start" rule), so runs parked before the switch keep working.
 *   - The result comes from graph state (`getState`): visited agents, the last answer, the
 *     interrupts still pending.
 */
import { Command, GraphRecursionError } from '@langchain/langgraph';
import type { ApprovalDecision, ApprovalPort, RunnerSnapshot, RunOwner } from '@tabs/agents/lib/engine/approval-port';
import { ResumeNotFoundError, RunAlreadyFinishedError, StaleResumeError, type PendingApproval } from '@tabs/agents/lib/engine/run';
import type { HoldDescription } from '@tabs/agents/lib/module/os-agent';

/** The engine name a module run reports. */
export const MODULE_ENGINE = 'module';

/** The minimum of `pg.Pool` the stamp store uses. */
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> };

export type ModuleRunStamp = { systemId: string; userId: string; domain: string; digest: string; commit: string | null };

/** Which threads run on a module, whose they are, and which module bytes they started on. */
export type ModuleRunStamps = {
  /** Record the stamp once; an existing stamp is kept (a restart never rewrites it). */
  stamp(threadId: string, s: ModuleRunStamp): Promise<void>;
  get(threadId: string): Promise<ModuleRunStamp | null>;
};

export async function migrateModuleRunStamps(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS agent_module_runs (
     thread_id  TEXT PRIMARY KEY,
     system_id  TEXT NOT NULL,
     user_id    TEXT NOT NULL,
     domain     TEXT NOT NULL,
     digest     TEXT NOT NULL,
     commit_sha TEXT,
     started_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

export function postgresModuleRunStamps(db: Queryable): ModuleRunStamps {
  return {
    async stamp(threadId, s) {
      await db.query(
        `INSERT INTO agent_module_runs (thread_id, system_id, user_id, domain, digest, commit_sha) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (thread_id) DO NOTHING`,
        [threadId, s.systemId, s.userId, s.domain, s.digest, s.commit],
      );
    },
    async get(threadId) {
      const { rows } = await db.query(`SELECT system_id, user_id, domain, digest, commit_sha FROM agent_module_runs WHERE thread_id = $1`, [threadId]);
      const r = rows[0];
      return r ? { systemId: String(r.system_id), userId: String(r.user_id), domain: String(r.domain), digest: String(r.digest), commit: (r.commit_sha as string | null) ?? null } : null;
    },
  };
}

/**
 * RETENTION: drop a run's module rows (its stamp and its hold decisions) with its checkpoint
 * thread. Tables that were never created (the flag was never on) are skipped, not an error.
 */
export async function deleteModuleThreadRows(db: Queryable, threadIds: readonly string[]): Promise<number> {
  if (threadIds.length === 0) return 0;
  let n = 0;
  for (const table of ['agent_module_runs', 'agent_hold_decisions']) {
    const { rows } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [table]);
    if (!rows[0]?.present) continue;
    const r = await db.query(`DELETE FROM ${table} WHERE thread_id = ANY($1)`, [threadIds]);
    n += r.rowCount ?? 0;
  }
  return n;
}

/** In-process stamps (memory checkpointer, tests). */
export function memoryModuleRunStamps(): ModuleRunStamps {
  const rows = new Map<string, ModuleRunStamp>();
  return {
    async stamp(threadId, s) {
      if (!rows.has(threadId)) rows.set(threadId, s);
    },
    async get(threadId) {
      return rows.get(threadId) ?? null;
    },
  };
}

type Graph = {
  stream: (input: unknown, config: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>>;
  getState: (config: Record<string, unknown>) => Promise<{
    values: Record<string, unknown>;
    next: string[];
    tasks: { name: string; interrupts: { id?: string; value?: unknown }[] }[];
  }>;
};

export type ModuleRunInput = {
  graph: Graph;
  runId: string;
  owner: RunOwner;
  /** Start: the user's task. Absent → resume. */
  task?: string;
  resumeDecision?: { interruptId: string; decision: ApprovalDecision };
  approvals: ApprovalPort;
  stamps: ModuleRunStamps;
  runner: RunnerSnapshot;
  /** The system principal (`os-<systemId>`) for attribution on the card. */
  agent: string;
  module: { digest: string; commit: string | null };
  recursionLimit?: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
};

export type ModuleRunResult = {
  engine: typeof MODULE_ENGINE;
  runId: string;
  path: string[];
  finalText: string;
  reachedEnd: boolean;
  parked: boolean;
  interrupted: boolean;
  heldApprovals: PendingApproval[];
  values: Record<string, unknown>;
  module: { digest: string; commit: string | null };
};

type ApprovalRequest = { type: 'tool_approval'; tool_call_id: string; name: string; args: Record<string, unknown>; description: string };

const isApprovalRequest = (v: unknown): v is ApprovalRequest =>
  !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'tool_approval' && typeof (v as { name?: unknown }).name === 'string';

function describe(req: ApprovalRequest): HoldDescription {
  let d: Partial<HoldDescription>;
  try {
    d = JSON.parse(req.description) as Partial<HoldDescription>;
  } catch (e) {
    // Fail closed, visibly: an unreadable payload goes to an admin with the reason on the card.
    return { approverRole: 'admin', reason: `unreadable_hold_description: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (d.approverRole === 'domain_admin' || d.approverRole === 'admin') return { approverRole: d.approverRole, reason: String(d.reason ?? '') };
  return { approverRole: 'admin', reason: 'unreadable_hold_description' };
}

/** The stock HITL decision for a Governance decision. */
export function hitlDecision(decision: ApprovalDecision): { type: 'approve' } | { type: 'reject'; message: string } {
  if (decision === 'approve') return { type: 'approve' };
  return { type: 'reject', message: decision === 'withdraw' ? 'withdrawn_by_requester' : 'rejected_by_approver' };
}

/** Is this thread a module run? A thread with no stamp was started by the v1 engine. */
export async function isModuleThread(stamps: ModuleRunStamps, runId: string): Promise<boolean> {
  return (await stamps.get(runId)) !== null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : String((p as { text?: string }).text ?? ''))).join('');
  return '';
}

export async function runAgentModule(input: ModuleRunInput): Promise<ModuleRunResult> {
  const config = { configurable: { thread_id: input.runId } };
  let streamInput: unknown;
  if (input.task !== undefined) {
    if (await input.stamps.get(input.runId)) throw new RunAlreadyFinishedError(input.runId);
    await input.stamps.stamp(input.runId, { ...input.owner, digest: input.module.digest, commit: input.module.commit });
    streamInput = { messages: [{ role: 'user', content: input.task }] };
  } else {
    const stamp = await input.stamps.get(input.runId);
    if (!stamp || stamp.systemId !== input.owner.systemId || stamp.userId !== input.owner.userId) throw new ResumeNotFoundError(input.runId);
    const snap = await input.graph.getState(config);
    const pending = snap.tasks.flatMap((t) => t.interrupts.map((i) => String(i.id ?? '')));
    if (pending.length === 0 && snap.next.length === 0) throw new RunAlreadyFinishedError(input.runId);
    if (input.resumeDecision) {
      if (!pending.includes(input.resumeDecision.interruptId)) {
        throw new StaleResumeError(input.runId, 'stale_interrupt', `interrupt '${input.resumeDecision.interruptId}' is not pending`, pending.length > 0);
      }
      streamInput = new Command({ resume: { [input.resumeDecision.interruptId]: hitlDecision(input.resumeDecision.decision) } });
      input.log?.(`resume runId=${input.runId} interrupt=${input.resumeDecision.interruptId} decision=${input.resumeDecision.decision}`);
    } else {
      streamInput = null; // continue after a crash: the last checkpoint is the truth
    }
  }

  const path: string[] = [];
  const filed: PendingApproval[] = [];
  let interrupted = false;
  try {
    const stream = await input.graph.stream(streamInput, {
      ...config,
      streamMode: 'updates',
      durability: 'sync',
      ...(input.recursionLimit ? { recursionLimit: input.recursionLimit } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    for await (const chunk of stream) {
      for (const [key, value] of Object.entries(chunk)) {
        if (key !== '__interrupt__') {
          if (key.startsWith('agent_')) path.push(key.slice('agent_'.length));
          continue;
        }
        for (const it of (Array.isArray(value) ? value : [value]) as { id?: string; value?: unknown }[]) {
          if (!it?.id || !isApprovalRequest(it.value)) continue;
          const d = describe(it.value);
          const card = await input.approvals.enqueueOnce({
            interruptKey: `${input.runId}:${it.id}`,
            runId: input.runId,
            threadId: input.runId,
            systemId: input.owner.systemId,
            node: it.value.tool_call_id,
            tool: it.value.name,
            args: it.value.args,
            approverRole: d.approverRole,
            domain: input.owner.domain,
            runner: input.runner,
            agent: input.agent,
          });
          filed.push({ approvalId: card.approvalId, interruptId: it.id, tool: it.value.name, node: it.value.tool_call_id });
          input.log?.(`parked runId=${input.runId} interrupt=${it.id}`);
        }
      }
    }
  } catch (e) {
    if (e instanceof GraphRecursionError || (e as Error)?.name === 'AbortError') interrupted = true;
    else throw e;
  }

  const snap = await input.graph.getState(config);
  const pending = snap.tasks.flatMap((t) => t.interrupts.filter((i) => isApprovalRequest(i.value)).map((i) => ({ id: String(i.id ?? ''), req: i.value as ApprovalRequest })));
  const heldApprovals: PendingApproval[] = [];
  for (const p of pending) {
    const known = filed.find((f) => f.interruptId === p.id);
    const card = known ?? (await input.approvals.find(`${input.runId}:${p.id}`).then((c) => (c ? { approvalId: c.approvalId, interruptId: p.id, tool: p.req.name, node: p.req.tool_call_id } : null)));
    if (card) heldApprovals.push(card);
  }
  const messages = (snap.values.messages ?? []) as { type?: string; _getType?: () => string; content?: unknown; tool_calls?: unknown[] }[];
  const lastAnswer = [...messages].reverse().find((m) => (m.type ?? m._getType?.()) === 'ai' && !(m.tool_calls ?? []).length);
  const parked = pending.length > 0;
  return {
    engine: MODULE_ENGINE,
    runId: input.runId,
    path,
    finalText: textOf(lastAnswer?.content),
    reachedEnd: !parked && !interrupted && snap.next.length === 0,
    parked,
    interrupted: interrupted || parked,
    heldApprovals,
    values: snap.values,
    module: input.module,
  };
}
