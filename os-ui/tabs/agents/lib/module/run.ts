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
import { ResumeNotFoundError, RunAlreadyFinishedError, StaleResumeError, type PendingApproval, type RunFailure } from '@tabs/agents/lib/engine/run';
import type { HoldDescription } from '@tabs/agents/lib/module/os-agent';
import type { AgenticStep } from '@core/runtime/agentic';
import { nodeStatus, type NodeRun, type NodeStatus } from '@tabs/agents/lib/build/agentic-graph';

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
  /** How many agents the team has (the `total` of the live node events). */
  agentCount?: number;
  /** The model alias an agent ran on (for the drill-down). */
  modelOf?: (agentId: string) => string;
  /** Live progress, the same hook signatures the v1 engine feeds the run route's SSE frames. */
  hooks?: ModuleRunHooks;
  /** One trace span per agent visit (the WP-31 writer, through `module/observe.ts`). */
  spans?: AgentSpans;
};

export type ModuleRunHooks = {
  onNodeStart?: (ev: { node: string; index: number; total: number }) => void;
  onStep?: (ev: { node: string; step: AgenticStep; index: number }) => void;
  onNodeComplete?: (ev: { node: string; status: NodeStatus; finalText: string }) => void;
  onInterrupt?: (ev: PendingApproval) => void;
};

/** Opens and closes one span per agent visit; `end` is idempotent. */
export type AgentSpans = {
  start(agentId: string, visit: number): void;
  end(agentId: string, status: { output?: unknown; error?: string; parked?: boolean }): void;
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
  /** The run drill-down: one entry per agent visit, rebuilt from the checkpointed transcript. */
  runs: NodeRun[];
  /** An agent visit FAILED (a call limit): the run stopped there, with a typed reason. */
  failed: boolean;
  failure?: RunFailure;
};

/** The stock limit middleware's typed errors (and the OS's text-tool-call guard, `os-agent.ts`) → the run's failure code. */
const LIMIT_CODES: Record<string, 'model_call_limit' | 'tool_call_limit' | 'text_tool_call'> = {
  ModelCallLimitMiddlewareError: 'model_call_limit',
  ToolCallLimitExceededError: 'tool_call_limit',
  TextToolCallError: 'text_tool_call',
};

/** The typed call-limit error in `e` (or its causes), if any. */
export function callLimitError(e: unknown): { code: 'model_call_limit' | 'tool_call_limit' | 'text_tool_call'; reason: string } | null {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i += 1) {
    const err = cur as { name?: string; message?: string; cause?: unknown };
    const code = err.name ? LIMIT_CODES[err.name] : undefined;
    if (code) return { code, reason: String(err.message ?? code) };
    cur = err.cause;
  }
  return null;
}

/** The failed visit in the drill-down (the last visit of the failed agent, or a new one). */
function markFailed(runs: NodeRun[], failure: RunFailure | undefined): NodeRun[] {
  if (!failure?.node) return runs;
  const last = [...runs].reverse().find((r) => r.node === failure.node);
  if (last) {
    last.status = 'failed';
    last.error = `${failure.code}: ${failure.reason}`;
  } else {
    runs.push({ node: failure.node, model: '', status: 'failed', error: `${failure.code}: ${failure.reason}`, result: { plan: '', steps: [], finalText: '', iterations: 0, toolCallingSupported: true, pending: [] } });
  }
  return runs;
}

type Msg = { type?: string; name?: string; content?: unknown; status?: string; tool_call_id?: string; tool_calls?: { id?: string; name: string; args: Record<string, unknown> }[] };

/**
 * The drill-down from the transcript in graph state, so a resumed run reports every visit, not
 * only the ones this process streamed. A visit starts at an AI message from a different agent;
 * tool results belong to the visit whose AI message asked for them.
 */
export function runsFromMessages(messages: readonly Msg[], modelOf: (agentId: string) => string): NodeRun[] {
  const runs: NodeRun[] = [];
  let cur: NodeRun | null = null;
  const args = new Map<string, Record<string, unknown>>();
  for (const m of messages) {
    if (m.type === 'ai' && m.name) {
      if (!cur || cur.node !== m.name) {
        cur = { node: m.name, model: modelOf(m.name), status: 'ok', result: { plan: '', steps: [], finalText: '', iterations: 0, toolCallingSupported: true, pending: [] } };
        runs.push(cur);
      }
      cur.result.iterations += 1;
      for (const c of m.tool_calls ?? []) if (c.id) args.set(c.id, c.args ?? {});
      if (!(m.tool_calls ?? []).length) cur.result.finalText = textOf(m.content);
    } else if (m.type === 'tool' && cur && m.name !== 'set_state') {
      cur.result.steps.push({ tool: String(m.name ?? ''), args: (m.tool_call_id && args.get(m.tool_call_id)) || {}, result: textOf(m.content), isError: m.status === 'error' });
      cur.status = nodeStatus(cur.result);
    }
  }
  return runs;
}

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
  const seenInterrupts = new Set<string>();
  let interrupted = false;
  let current: string | null = null;
  let failure: RunFailure | undefined;
  // Live progress (WP-53b): which agent is running, its tool steps as they finish, its end. The
  // tool-call args come from the AI message that asked for them (inside the agent's subgraph).
  const visits = new Map<string, number>();
  const argsOf = new Map<string, Record<string, unknown>>();
  const stepIndex = new Map<string, number>();
  const total = input.agentCount ?? 0;
  const fileCard = async (it: { id?: string; value?: unknown }) => {
    if (!it?.id || !isApprovalRequest(it.value) || seenInterrupts.has(it.id)) return;
    seenInterrupts.add(it.id);
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
    input.hooks?.onInterrupt?.(filed[filed.length - 1]);
    input.log?.(`parked runId=${input.runId} interrupt=${it.id}`);
  };
  try {
    const stream = await input.graph.stream(streamInput, {
      ...config,
      streamMode: ['updates', 'tasks'],
      subgraphs: true,
      durability: 'sync',
      ...(input.recursionLimit ? { recursionLimit: input.recursionLimit } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    for await (const part of stream as AsyncIterable<unknown>) {
      const [ns, mode, chunk] = part as [string[], string, Record<string, unknown>];
      const agentNs = ns.find((n) => n.startsWith('agent_'));
      const agentId = agentNs ? agentNs.slice('agent_'.length).split(':')[0] : null;
      if (mode === 'tasks') {
        // A task START event carries `input`; its result event carries `result`.
        const name = String(chunk.name ?? '');
        if (ns.length === 0 && name.startsWith('agent_') && 'input' in chunk) {
          const id = name.slice('agent_'.length);
          const n = (visits.get(id) ?? 0) + 1;
          visits.set(id, n);
          current = id;
          input.spans?.start(id, n);
          input.hooks?.onNodeStart?.({ node: id, index: path.length, total });
        }
        continue;
      }
      for (const [key, value] of Object.entries(chunk)) {
        if (key === '__interrupt__') {
          for (const it of (Array.isArray(value) ? value : [value]) as { id?: string; value?: unknown }[]) await fileCard(it);
          continue;
        }
        const msgs = ((value as { messages?: unknown[] } | null)?.messages ?? []) as { type?: string; name?: string; content?: unknown; status?: string; tool_call_id?: string; tool_calls?: { id?: string; name: string; args: Record<string, unknown> }[] }[];
        if (agentId) {
          // Inside an agent: record the calls the model asked for, report each finished tool step.
          for (const m of msgs) {
            for (const c of m.tool_calls ?? []) if (c.id) argsOf.set(c.id, c.args ?? {});
            if (m.type === 'tool' && m.tool_call_id && m.name !== 'set_state') {
              const i = stepIndex.get(agentId) ?? 0;
              stepIndex.set(agentId, i + 1);
              input.hooks?.onStep?.({ node: agentId, index: i, step: { tool: String(m.name ?? ''), args: argsOf.get(m.tool_call_id) ?? {}, result: textOf(m.content), isError: m.status === 'error' } });
            }
          }
          continue;
        }
        if (ns.length === 0 && key.startsWith('agent_')) {
          const id = key.slice('agent_'.length);
          path.push(id);
          const answer = [...msgs].reverse().find((m) => m.type === 'ai' && !(m.tool_calls ?? []).length);
          const finalText = textOf(answer?.content);
          // The visit's real status, by the v1 rule (`nodeStatus`): a policy refusal → denied, any
          // other failed tool → error, else ok.
          const status = runsFromMessages(msgs as Msg[], () => '').at(-1)?.status ?? 'ok';
          input.spans?.end(id, { output: { chars: finalText.length, status } });
          input.hooks?.onNodeComplete?.({ node: id, status, finalText });
        }
      }
    }
  } catch (e) {
    const limit = callLimitError(e);
    for (const id of visits.keys()) input.spans?.end(id, { error: limit ? `${limit.code}: ${limit.reason}` : (e as Error)?.message ?? String(e) });
    if (limit) {
      // A call limit FAILS the agent visit with a typed reason — it is never the team's answer.
      failure = { node: current, code: limit.code, reason: limit.reason };
      if (current) input.hooks?.onNodeComplete?.({ node: current, status: 'failed', finalText: '' });
      input.log?.(`failed runId=${input.runId} node=${current ?? '-'} code=${limit.code}`);
    } else if (e instanceof GraphRecursionError || (e as Error)?.name === 'AbortError') interrupted = true;
    else throw e;
  }
  // A node still open here parked on an approval (its span says so; its result comes on resume).
  for (const id of visits.keys()) input.spans?.end(id, { parked: true });

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
    // A failed run's answer IS the failure — never the previous agent's last answer.
    finalText: failure ? `The run stopped: agent ${failure.node ?? '(unknown)'} failed (${failure.code ?? 'error'}): ${failure.reason}` : textOf(lastAnswer?.content),
    reachedEnd: !failure && !parked && !interrupted && snap.next.length === 0,
    parked,
    interrupted: interrupted || parked,
    heldApprovals,
    values: snap.values,
    module: input.module,
    runs: markFailed(runsFromMessages(messages as Msg[], input.modelOf ?? (() => '')), failure),
    failed: !!failure,
    ...(failure ? { failure } : {}),
  };
}
