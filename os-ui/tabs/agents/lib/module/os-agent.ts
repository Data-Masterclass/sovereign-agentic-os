/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    `createOsAgent` — the committed LangGraph module, wrapped in the OS's governance
 * USER STORY: As the owner I want the OS to run the team's own `graph.mjs` and add ONLY what the OS
 *             is for — every tool call as the signed-in runner within the system's grants, a write
 *             that needs approval paused for a person, a replayed write never sent twice, models
 *             through the gateway with the system's own key — so the graph an engineer runs with
 *             `node run.mjs` and the graph the OS runs are one file.
 * ARCHITECTURE:
 *   - Input: a loaded module (`module/load.ts`, hash-verified) and the OS collaborators. Output:
 *     `module.buildGraph({ model, tools, middleware, checkpointer, maxSteps })` — the module's own
 *     compiled `StateGraph`. Nothing here builds graph topology.
 *   - TOOLS (`osTools`): one LangChain `tool()` per name in the module's `TOOL_NAMES`. Its handler
 *     calls the governed executor (production: `grantedToolExecutor` → grant scope → `handleRpc`
 *     AS THE RUNNER) behind the WP-26 tool-call ledger, with the idempotency key
 *     `<thread>:<toolCallId>` — the model's call id is checkpointed with the AI message, so a
 *     replayed step carries the same key and a write is never dispatched twice. Results are bounded
 *     and time-limited by `callToolGuarded`; a refusal is the executor's typed text, never a throw.
 *   - HOLDS, decided ONCE per call (WP-26 behaviour, 03 Revision 1): `holdDecider` is an
 *     `afterModel` middleware that records `{ held, approverRole }` for every tool call of the turn
 *     in the OS's own `agent_hold_decisions` table (`<thread>:<toolCallId>`, first write wins),
 *     before any tool runs. The stock `humanInTheLoopMiddleware({ interruptMode: 'per_call' })`
 *     pauses a call whose stored decision says held — it never asks the rule again, so a policy
 *     change while parked cannot run a rejected call. A call with no stored decision is held for an
 *     admin (fail closed). Decisions: approve, or reject (a withdrawal is a reject with
 *     `withdrawn_by_requester`). Why a table and not a graph state channel: with `createAgent`
 *     v2 each tool call is a `Send` task whose request state carries only `messages`
 *     (langchain 1.6.7, measured), so a middleware channel is invisible to the gate; and the hold
 *     is OS governance, which belongs in the OS's tables, not in the native graph.
 *   - MODEL: `deps.modelFor` — production passes `core/adapters/litellm/chat-model.ts`
 *     `gatewayChatModel` (ChatOpenAI → LiteLLM, scoped key, no client retries).
 */
import { tool, createMiddleware, humanInTheLoopMiddleware } from 'langchain';
import type { ToolExecutor, ToolSpec } from '@core/runtime/agentic';
import type { HoldDecision } from '@tabs/agents/lib/build/hold';
import { callToolGuarded } from '@tabs/agents/lib/engine/tool-result';
import type { LoadedGraphModule } from '@core/adapters/agent-module/load';

/** One stored hold decision. */
export type StoredHold = { held: boolean; approverRole: 'domain_admin' | 'admin' | null };

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> };

/** Where each call's hold decision is kept: decided once, read on every (re-)evaluation. */
export type HoldStore = {
  /** Record the decision for `key` unless one exists; returns the decision on record. */
  record(key: string, hold: StoredHold): Promise<StoredHold>;
  get(key: string): Promise<StoredHold | null>;
};

export async function migrateHoldStore(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS agent_hold_decisions (
     call_key      TEXT PRIMARY KEY,
     thread_id     TEXT NOT NULL,
     held          BOOLEAN NOT NULL,
     approver_role TEXT,
     decided_at    TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.query(`CREATE INDEX IF NOT EXISTS agent_hold_decisions_thread ON agent_hold_decisions (thread_id)`);
}

export function postgresHoldStore(db: Queryable): HoldStore {
  const row = (r: Record<string, unknown> | undefined): StoredHold | null =>
    r ? { held: Boolean(r.held), approverRole: (r.approver_role as StoredHold['approverRole']) ?? null } : null;
  return {
    async record(key, hold) {
      await db.query(
        `INSERT INTO agent_hold_decisions (call_key, thread_id, held, approver_role) VALUES ($1,$2,$3,$4) ON CONFLICT (call_key) DO NOTHING`,
        [key, key.slice(0, key.lastIndexOf(':')), hold.held, hold.approverRole],
      );
      return (await this.get(key)) ?? hold;
    },
    async get(key) {
      const { rows } = await db.query(`SELECT held, approver_role FROM agent_hold_decisions WHERE call_key = $1`, [key]);
      return row(rows[0]);
    },
  };
}

export function memoryHoldStore(): HoldStore & { rows: Map<string, StoredHold> } {
  const rows = new Map<string, StoredHold>();
  return {
    rows,
    async record(key, hold) {
      if (!rows.has(key)) rows.set(key, hold);
      return rows.get(key)!;
    },
    async get(key) {
      return rows.get(key) ?? null;
    },
  };
}

/** The approval card's payload, carried in the stock interrupt's `description`. */
export type HoldDescription = { approverRole: 'domain_admin' | 'admin'; reason: string };

/** The governed tools, one per name the module declares. */
export function osTools(input: {
  names: readonly string[];
  specs: readonly ToolSpec[];
  executor: ToolExecutor;
  threadId: string;
  timeoutMs?: number;
  maxChars?: number;
}) {
  const specOf = new Map(input.specs.map((s) => [s.name, s]));
  return input.names.map((name) => {
    const spec = specOf.get(name);
    return tool(
      async (args: Record<string, unknown>, config: { toolCall?: { id?: string } }) => {
        const callId = config?.toolCall?.id;
        const out = await callToolGuarded(input.executor, { name, args: args ?? {} }, {
          timeoutMs: input.timeoutMs,
          maxChars: input.maxChars,
          ...(callId ? { idempotencyKey: `${input.threadId}:${callId}` } : {}),
        });
        return out.text;
      },
      {
        name,
        // A tool this runner's role cannot see still exists in the graph; the executor refuses it
        // with a typed result the model can read.
        description: spec?.description ?? `${name} (not available to this runner; the call is refused)`,
        schema: spec?.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
      },
    );
  });
}

type ToolCallLike = { id?: string; name: string; args: Record<string, unknown> };

/** Decide each new tool call ONCE, before any tool of the turn runs, and keep the decision. */
export function holdDecider(decide: (tool: string, args: Record<string, unknown>) => HoldDecision, store: HoldStore, threadId: string) {
  return createMiddleware({
    name: 'OsHoldDecider',
    afterModel: async (state) => {
      const last = state.messages.at(-1) as { tool_calls?: ToolCallLike[] } | undefined;
      for (const c of last?.tool_calls ?? []) {
        if (!c.id) continue;
        const key = `${threadId}:${c.id}`;
        if (await store.get(key)) continue;
        const d = decide(c.name, c.args ?? {});
        await store.record(key, d.held ? { held: true, approverRole: d.approverRole } : { held: false, approverRole: null });
      }
      return undefined;
    },
  });
}

/** The stock per-call HITL, gated ONLY by the stored decision (missing → held for an admin). */
export function osApprovals(names: readonly string[], store: HoldStore, threadId: string) {
  const stored = async (id: string | undefined) => (id ? store.get(`${threadId}:${id}`) : null);
  const interruptOn = Object.fromEntries(
    names.map((n) => [
      n,
      {
        allowedDecisions: ['approve', 'reject'] as ('approve' | 'reject')[],
        when: async (r: { toolCall: { id?: string } }) => (await stored(r.toolCall.id))?.held ?? true,
        description: async (tc: { id?: string }) => {
          const h = await stored(tc.id);
          const d: HoldDescription = h?.held && h.approverRole
            ? { approverRole: h.approverRole, reason: 'held_by_policy' }
            : { approverRole: 'admin', reason: h ? 'held_by_policy' : 'no_stored_decision' };
          return JSON.stringify(d);
        },
      },
    ]),
  );
  return humanInTheLoopMiddleware({ interruptMode: 'per_call', interruptOn });
}

export type OsAgentDeps = {
  /** The chat model for an agent (its alias, or the OS's tools-role model). */
  modelFor: (agent: { id: string; model: string | null }) => unknown;
  /** The runner's role-scoped tool specs (schemas and descriptions). */
  specs: readonly ToolSpec[];
  /** The governed executor (grant scope → `handleRpc` as the runner), ledger in front. */
  executor: ToolExecutor;
  /** The hold rule, asked once per call by `holdDecider`. */
  decide: (tool: string, args: Record<string, unknown>) => HoldDecision;
  /** Where the decisions are kept (production: Postgres, the checkpointer's database). */
  holds: HoldStore;
  threadId: string;
  checkpointer: unknown;
  maxSteps?: number;
  toolCallTimeoutMs?: number;
  toolResultMaxChars?: number;
};

/** The module's own graph, with the OS's tools and middleware injected. */
export function createOsAgent(mod: LoadedGraphModule, deps: OsAgentDeps) {
  const tools = osTools({
    names: mod.TOOL_NAMES,
    specs: deps.specs,
    executor: deps.executor,
    threadId: deps.threadId,
    timeoutMs: deps.toolCallTimeoutMs,
    maxChars: deps.toolResultMaxChars,
  });
  // `set_state` is the module's own tool (team state, no OS data): never held.
  const middleware = [
    holdDecider((t, a) => (t === 'set_state' ? { held: false } : deps.decide(t, a)), deps.holds, deps.threadId),
    osApprovals(mod.TOOL_NAMES, deps.holds, deps.threadId),
  ];
  return mod.buildGraph({ model: deps.modelFor, tools, middleware, checkpointer: deps.checkpointer, maxSteps: deps.maxSteps });
}
