/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type IR, type IRNode } from '../langgraph-compile.ts';
import { classifyModelNeed, type ModelNeed } from '../routing.ts';
import {
  runAgentic,
  type AgenticResult,
  type AgenticStep,
  type LlmCall,
  type ToolExecutor,
  type ToolSpec,
} from '@/lib/assistant/agentic';
import { compactToolResult } from '@/lib/infra/context/context-assembler';
import { estimateTokens } from '@/lib/knowledge/context-pack';
import { curateContext, type CurateCandidate, type EmbedFn } from '@/lib/infra/context/librarian';

/**
 * THE AGENTIC GRAPH EXECUTOR — the core of the Software Delivery Team.
 *
 * It walks a compiled LangGraph {@link IR} and, per node, runs the EXISTING
 * per-user agentic harness ({@link runAgentic}, the same PLAN→ACT loop the live
 * software build chat uses) with:
 *   • that node's AUTO-resolved model as the ACT model ({@link resolveNodeModel}:
 *     a real pin wins, else read-only gatherers → fast, judgment/writers → reasoning),
 *     reasoning tier for the PLAN — so per-agent model routing is genuinely live;
 *   • that node's narrowed, role-scoped tool specs (injected `toolSpecsFor`);
 *   • the injected governed `callTool` — in production this is
 *     `tabToolExecutor(user,'software')` → `handleRpc(user, …)`, i.e. every tool
 *     runs AS THE RUNNING USER (OPA + role floor + Langfuse), never a system
 *     principal. This closes the run-scope-as-system-principal gap.
 *
 * This module is TRANSPORT-FREE and side-effect-free: `llm`, `callTool` and the
 * per-node tool specs are all INJECTED, so it is trivially unit-testable and
 * carries no `server-only` coupling. The server wiring lives in
 * `agentic-graph-server.ts`.
 *
 * v1 routing is DETERMINISTIC and honest: the compiled `when` guards are not
 * evaluated by any runtime, so we walk the graph in a fixed, visited-once order
 * (entrypoint → supervisor members in declared order, following handoffs) — the
 * same walk `run-graph.ts` uses. The team's single voice (the last node, e.g.
 * `communication`) speaks last, and its final text is the user-facing reply.
 */

/**
 * A node's outcome:
 *   'ok'     — produced output, no errored tools;
 *   'error'  — a tool EXECUTION error (bad SQL, timeout, type error) — NOT a policy block;
 *   'denied' — a genuine OPA/policy denial or missing grant blocked a tool;
 *   'failed' — the node itself threw.
 * `error` and `denied` are deliberately distinct: a bad-SQL error is not a governance
 * denial, and mislabeling it alarms the student with a false "DENIED".
 */
export type NodeStatus = 'ok' | 'failed' | 'denied' | 'error';

/** Whether an errored step was blocked by POLICY (governance) or failed in EXECUTION. */
export type ErrorKind = 'policy' | 'exec';

/**
 * The typed error codes a GOVERNANCE block surfaces (server.ts `structuredError` /
 * os-tools `errorResult`): a role-floor `forbidden`, a missing/out-of-scope grant
 * (`not_found` — "Tool not available"), or a held write (`held`). Anything else —
 * a Trino syntax/type error, a bad_request, a timeout, a raw thrown message — is an
 * EXECUTION error, which is not a policy denial.
 */
const POLICY_ERROR_CODES = new Set(['forbidden', 'held', 'not_found']);

/**
 * Classify an errored step as a POLICY denial vs an EXECUTION error by parsing the
 * governed tool-result envelope (`{"error":{"code":…}}`). Unparseable/absent code →
 * 'exec' (a raw Trino/engine failure carries no typed policy code). Callers should
 * only invoke this for steps where `isError` is true.
 */
export function classifyStepError(resultText: string): ErrorKind {
  try {
    const parsed = JSON.parse(resultText) as { error?: { code?: string } };
    const code = parsed?.error?.code;
    if (typeof code === 'string' && POLICY_ERROR_CODES.has(code)) return 'policy';
  } catch {
    /* not a typed envelope — fall through to exec */
  }
  return 'exec';
}

export type NodeRun = {
  node: string;
  model: string;
  /** The resolved AUTO tier ('fast' | 'reasoning') the ACT model came from. */
  tier?: 'fast' | 'reasoning';
  /** Why that tier was chosen (e.g. "read-only gatherer: query_data") — for the drill-down. */
  tierReason?: string;
  status: NodeStatus;
  result: AgenticResult;
  /**
   * A READABLE rendering of what this node was GIVEN: its role prompt + the "TEAM
   * PROGRESS SO FAR" handoff (prior agents' conclusions and material data) + the
   * user turn. Captured so the UI can show "what this agent received" in the
   * drill-down. Size-bounded so a long transcript can't bloat the run response.
   */
  input?: string;
  /** Present only when the node threw — the reason, for a node-level failure surface. */
  error?: string;
};

/** Upper bound on the captured node `input` (chars) so the run response stays lean. */
const MAX_NODE_INPUT_CHARS = 8_000;

/** Bound a captured input string to its head, marking the elision honestly. */
function boundInput(text: string): string {
  return text.length <= MAX_NODE_INPUT_CHARS
    ? text
    : `${text.slice(0, MAX_NODE_INPUT_CHARS)}\n… [truncated ${text.length - MAX_NODE_INPUT_CHARS} more chars]`;
}

/** Render the user turn(s) this node received, appended after its system context. */
function renderUserTurn(messages: { role: 'user' | 'assistant'; content: string }[]): string {
  const last = messages.filter((m) => m.role === 'user').at(-1);
  return last ? `\n\n--- USER TURN ---\n${last.content}` : '';
}

/** The latest user message text — the task the handoff is being curated toward. */
function lastUserContent(messages: { role: 'user' | 'assistant'; content: string }[]): string {
  return messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
}

/**
 * Derive a node's status as its WORST real outcome: threw → 'failed'; any POLICY-denied
 * tool → 'denied'; else any EXECUTION-errored tool → 'error'; else 'ok'. A bad-SQL
 * error is 'error', never 'denied' — only a real governance block earns 'denied'.
 */
function nodeStatus(result: AgenticResult, threw?: string): NodeStatus {
  if (threw) return 'failed';
  const errored = result.steps.filter((s) => s.isError);
  if (errored.length === 0) return 'ok';
  if (errored.some((s) => classifyStepError(s.result) === 'policy')) return 'denied';
  return 'error';
}

export type AgenticGraphResult = {
  /** The node ids that ran, in order. */
  path: string[];
  /** Each node's model + full PLAN→ACT trace. */
  runs: NodeRun[];
  /** The last node's final text — the team's single user-facing reply. */
  finalText: string;
};

export type AgenticGraphDeps = {
  llm: LlmCall;
  /** The role-scoped tool specs a node may drive (⊆ system grants, per-user). */
  toolSpecsFor: (node: IRNode) => ToolSpec[];
  /** The governed executor — production: runs as the signed-in user. */
  callTool: ToolExecutor;
  /** Preamble shared by every node (OS rules + software tab context). */
  preamble: string;
  /** Reasoning tier used for every node's PLAN step. */
  reasoningModel: string;
  /** The FAST ACT model an Auto node resolves to when it does read-only gathering. */
  execModel: string;
  /**
   * PHASE 2 SEAM (design-only, NOT wired). An optional LLM tie-breaker consulted at
   * BUILD time for a node whose deterministic tier is genuinely ambiguous — never on
   * the run hot-path, never called today. When present a future builder may ask it to
   * settle borderline nodes; absent (always, now) the deterministic classifier decides
   * alone. Declared here so the seam is a real, typed contract rather than a TODO.
   */
  tieBreaker?: ModelTieBreaker;
  maxIterations?: number;
  /**
   * Input token ceiling for every node's model call — the bound each node's
   * (growing) transcript is assembled to before it reaches the gateway. Fixes the
   * multi-node LiteLLM 400 ContextWindowExceededError. Forwarded to `runAgentic`;
   * unset uses the harness default.
   */
  budget?: number;
  /** Cap on each node's own model output (the reserved-output tail). */
  maxOutputTokens?: number;
  /** Toggled-off agents: skipped, their tools never run. */
  disabled?: string[];
  /**
   * OPTIONAL live embedder for RELEVANCE-CURATED handoffs (the Context Librarian).
   * When present AND the embedding source is genuinely semantic (not the offline
   * hash), the immediate predecessor's material outputs are kept WHOLE by relevance
   * to the downstream node's need rather than blindly head-truncated to
   * {@link HANDOFF_KEEP_ROWS}. Absent, or when {@link AgenticGraphDeps.embedSource}
   * reports `offline-hash`, the handoff falls back to the existing keepRows path
   * (relevance over hash vectors is meaningless). Never affects the loop-breaker or
   * per-node observability — it only shapes the predecessor material block.
   */
  embed?: EmbedFn;
  /**
   * The source of the embedder's most recent call (`litellm` | `offline-hash`), used
   * as the fallback guard: `offline-hash` (or undefined) → keep the deterministic
   * keepRows handoff. Pair with {@link AgenticGraphDeps.embed} (see `librarian-live`).
   */
  embedSource?: () => 'litellm' | 'offline-hash' | undefined;
  /**
   * LIVE PROGRESS hooks (optional, transport-free). Fired as the walk happens so a
   * caller can stream what is happening RIGHT NOW — never changes the returned
   * result. `onNodeStart` fires as a node begins; `onStep` fires after each governed
   * tool step of that node (forwarded from the harness); `onNodeComplete` fires with
   * the node's outcome once it settles (including a `failed` node). Absent → the run
   * is silent (identical to before).
   */
  onNodeStart?: (ev: { node: string; index: number; total: number }) => void;
  onStep?: (ev: { node: string; step: AgenticStep; index: number }) => void;
  onNodeComplete?: (ev: { node: string; status: NodeStatus; finalText: string }) => void;
};

/**
 * PHASE 2 SEAM — the LLM tie-breaker contract. Given a node, its granted tool specs
 * and the deterministic `need` the classifier reached, return the settled tier. This
 * is the ONLY place a model would ever be consulted for routing, and only for BUILD-
 * time ambiguity. It is NOT wired: nothing calls this today; {@link resolveNodeModel}
 * is fully deterministic. Declared so a later phase can drop in an implementation
 * without changing the executor's shape.
 */
export type ModelTieBreaker = (node: IRNode, tools: ToolSpec[], need: ModelNeed) => Promise<ModelNeed>;

/** The resolved routing decision for a node: the model_name plus WHY (for the UI). */
export type ResolvedModel = { model: string; tier: ModelNeed; reason: string };

/** The sentinel a UI may store to mean "classify me" (equivalent to an unset model). */
const AUTO_SENTINEL = 'auto';

/**
 * AUTO per-node model selection (deterministic, pure, tested). Decide the ACT model
 * for one node:
 *   • USER OVERRIDE WINS — a real pinned `node.model` (not unset, not the `'auto'`
 *     sentinel) is honored verbatim; tier is inferred from the alias for display only.
 *   • Otherwise CLASSIFY from the node's granted tools + role/name/prompt (via
 *     {@link classifyModelNeed}): read-only gatherer → `execModel` (fast); any
 *     write/decide tool, or zero tools, → `reasoningModel`.
 * Zero LLM cost. Returns the model_name, the tier, and a human `reason`.
 */
export function resolveNodeModel(node: IRNode, deps: AgenticGraphDeps): ResolvedModel {
  const pinned = node.model?.trim();
  if (pinned && pinned.toLowerCase() !== AUTO_SENTINEL) {
    // User pinned a real model — honor it. Infer a display tier from the alias: the
    // fast execModel reads as 'fast', anything else as 'reasoning'.
    const tier: ModelNeed = pinned === deps.execModel ? 'fast' : 'reasoning';
    return { model: pinned, tier, reason: `pinned by builder: ${pinned}` };
  }
  const roleText = `${node.id} ${node.prompt ?? ''}`;
  const { need, reason } = classifyModelNeed(deps.toolSpecsFor(node).map((t) => t.name), roleText);
  return { model: need === 'fast' ? deps.execModel : deps.reasoningModel, tier: need, reason };
}

/**
 * The deterministic visit order over the IR: BFS from the entrypoint, a
 * supervisor enqueues its members in declared order, handoffs are followed, and
 * every node runs at most once. Mirrors the walk in `run-graph.ts` so the
 * ordering is identical to the mock test-invocation. Disabled agents are skipped.
 */
export function nodeOrder(ir: IR, disabled: Set<string> = new Set()): string[] {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const commandsByFrom = new Map<string, string[]>();
  for (const c of ir.commands) {
    const list = commandsByFrom.get(c.from) ?? [];
    list.push(c.to);
    commandsByFrom.set(c.from, list);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [ir.entrypoint];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (disabled.has(id)) continue; // skipped: never runs, never routes onward
    const node = nodeById.get(id);
    if (!node) continue;
    order.push(id);
    if (node.supervisor) {
      for (const m of node.members) if (!visited.has(m)) queue.push(m);
    }
    for (const to of commandsByFrom.get(id) ?? []) if (!visited.has(to)) queue.push(to);
  }
  return order;
}

/**
 * One prior node's handoff: the rendered narration+material `block`, plus the RAW
 * inputs (`finalText`, `steps`) so a downstream node can RE-RENDER this entry with a
 * relevance-curated material selection (the Librarian handoff) instead of the flat
 * keepRows compaction. `finalText`/`steps` are omitted on summarized/synthetic entries.
 */
type HandoffEntry = { node: string; block: string; finalText?: string; steps?: AgenticStep[] };

/**
 * Instruction to the DOWNSTREAM node: the handoff below carries the prior agents'
 * ACTUAL outputs (scorecards, metric values, query rows) — use them, never re-ask
 * the user for data a teammate already produced.
 */
const HANDOFF_DIRECTIVE = [
  'Your teammates have already run before you. "TEAM PROGRESS SO FAR" below carries',
  'each prior agent\'s conclusion AND the material data it produced (query rows,',
  'metric values, scorecards). USE that data directly — it is the input to your job.',
  'NEVER ask the user for information a prior agent already produced; if you need a',
  "prior result, read it from the handoff. Only the most recent agent's output is",
  'pinned in full; older ones may be summarized.',
  '',
  'DO NOT re-run a query or re-compute a result a teammate already handed you. A large',
  'row-set may be shown truncated (e.g. "…(N more rows)") — reason over the rows and',
  'the prior agent\'s conclusion you WERE given; only fetch a source yourself if a',
  'specific value you need is genuinely absent from the handoff, and then fetch just',
  'that one thing. Spend your tool budget on NEW work (your synthesis/recommendation),',
  'not on re-deriving your teammate\'s output.',
].join('\n');

/**
 * Row allowance for inter-node handoffs. A scorecard from the evaluator can span
 * many campaigns — the recommender must see ALL rows to reason over them without
 * re-querying. This is deliberately MUCH larger than the default (5) used for the
 * in-context assembler so a typical scorecard (≤60 campaigns) passes whole.
 * The handoff budget ceiling in `budgetTranscript` / `nodeSystem` still applies as
 * the outer size guard, so this cannot blow the model window.
 */
const HANDOFF_KEEP_ROWS = 60;

/**
 * Render one node's handoff block: its finalText (narration) followed by a compact
 * rendering of its MATERIAL tool outputs — the data it fetched/produced (query
 * result rows, metric values, scorecard) — so a downstream node has the actual
 * results to work from, not just the narration. Errored/denied steps are noted so
 * the next node knows what was NOT obtained. Each result is compacted (row-set →
 * header+first-N up to HANDOFF_KEEP_ROWS; long text → head+tail) so the handoff
 * stays budget-friendly while preserving full scorecards for downstream reasoning.
 */
function handoffBlock(node: string, finalText: string, steps: AgenticStep[]): string {
  const parts = [`## ${node}`, finalText.trim() || '(no narration)'];
  const material = steps.filter((s) => !s.isError && s.result.trim());
  const failed = steps.filter((s) => s.isError);
  if (material.length > 0) {
    parts.push('', `### ${node} — data produced (use this directly):`);
    for (const s of material) {
      // Pass HANDOFF_KEEP_ROWS so a full scorecard (up to 60 rows) is preserved;
      // the global default (5) is only used elsewhere (in-context assembler).
      parts.push(`- ${s.tool}: ${compactToolResult(s.result.trim(), {}, HANDOFF_KEEP_ROWS)}`);
    }
  }
  if (failed.length > 0) {
    parts.push('', `### ${node} — tools that did NOT return data: ${failed.map((s) => s.tool).join(', ')}`);
  }
  return parts.join('\n');
}

/**
 * The CURATED handoff block (Context Librarian). Same shape as {@link handoffBlock},
 * but the predecessor's MATERIAL tool outputs are selected by RELEVANCE to `need`
 * (the downstream node's role + the user task) within `budget`, rather than every
 * output being flatly head-truncated to {@link HANDOFF_KEEP_ROWS}. A clearly-relevant
 * output (cosine ≥ the Librarian's keepFullAbove) is kept WHOLE by its tool-result
 * rule — the recommender-needs-the-whole-scorecard case wins over budget pressure —
 * while off-topic outputs are compacted or dropped so the block fits.
 *
 * Falls back to the flat {@link handoffBlock} rendering when: there is no material,
 * the material already fits, or the Librarian declines to curate (no/failed
 * embedder) — so behaviour is IDENTICAL to the keepRows path whenever curation isn't
 * genuinely engaged. NEVER throws (Librarian degrades gracefully).
 */
async function curatedHandoffBlock(
  node: string,
  finalText: string,
  steps: AgenticStep[],
  need: string,
  budget: number,
  embed: EmbedFn,
  embedSource?: () => 'litellm' | 'offline-hash' | undefined,
): Promise<string> {
  const material = steps.filter((s) => !s.isError && s.result.trim());
  const failed = steps.filter((s) => s.isError);
  if (material.length === 0) return handoffBlock(node, finalText, steps);

  // The predecessor's material outputs COMPETE by relevance to the downstream need.
  // They are the direct-handoff data (all `tool-result`), so a clearly-relevant one
  // (cosine ≥ keepFullAbove) is kept WHOLE by the Librarian's tool-result rule — the
  // recommender-needs-the-whole-scorecard case — while off-topic outputs are compacted
  // or dropped. We do NOT blanket-mark them `predecessor` (that would keep even the
  // irrelevant ones whole and defeat the point); relevance decides among them.
  const candidates: CurateCandidate[] = material.map((s, i) => ({
    kind: 'tool-result',
    id: `${node}:${s.tool}:${i}`,
    text: `- ${s.tool}: ${s.result.trim()}`,
  }));
  const curation = await curateContext({ candidates, budget, need, embed });
  // Post-embed guard: if the embedder degraded to the offline hash (cosine relevance
  // over hash vectors is noise), OR the Librarian didn't actively curate (under-budget
  // / fallback), keep the deterministic keepRows rendering so nothing regresses.
  if (!curation.curated || embedSource?.() === 'offline-hash') {
    return handoffBlock(node, finalText, steps);
  }

  const parts = [`## ${node}`, finalText.trim() || '(no narration)'];
  parts.push('', `### ${node} — data produced (use this directly):`);
  // Curated texts already carry the "- tool: …" prefix; compacted ones stay bounded.
  for (const c of curation.candidates) parts.push(c.text);
  if (failed.length > 0) {
    parts.push('', `### ${node} — tools that did NOT return data: ${failed.map((s) => s.tool).join(', ')}`);
  }
  return parts.join('\n');
}

/** True when a real, semantic embedder is available — the guard for relevance
 *  curation. The offline hash embedding is deterministic but semantically empty, so
 *  cosine relevance over it is noise; in that case we keep the deterministic path. */
function canCurate(deps: AgenticGraphDeps): boolean {
  return typeof deps.embed === 'function' && deps.embedSource?.() !== 'offline-hash';
}

/**
 * The share of a node's input budget the between-node handoff may occupy. The rest
 * is preamble + role + the node's own ACT loop. Kept modest so the handoff never
 * crowds out the node's own working context.
 */
const HANDOFF_BUDGET_FRACTION = 0.4;
/** Fallback handoff ceiling (tokens) when no `budget` is supplied by the caller. */
const DEFAULT_HANDOFF_BUDGET = 6_000;

/** The token ceiling the whole between-node handoff may occupy for a node call. */
function handoffCeiling(budget?: number): number {
  return Math.floor((budget ?? DEFAULT_HANDOFF_BUDGET / HANDOFF_BUDGET_FRACTION) * HANDOFF_BUDGET_FRACTION);
}

/**
 * RELEVANCE-curate the IMMEDIATE predecessor's handoff entry against the DOWNSTREAM
 * node's need (its role/prompt + the user task), in place, using the Context
 * Librarian. This is the priority handoff use-case: the predecessor's material is
 * kept WHOLE by relevance within the handoff ceiling rather than flatly truncated to
 * {@link HANDOFF_KEEP_ROWS}. A no-op (returns the transcript untouched) when there is
 * no embedder, the source is the offline hash, or the predecessor carries no raw
 * steps to re-render — so the deterministic keepRows path is the graceful fallback.
 */
async function curatePredecessor(
  transcript: HandoffEntry[],
  node: IRNode,
  userTask: string,
  deps: AgenticGraphDeps,
): Promise<HandoffEntry[]> {
  if (!canCurate(deps) || transcript.length === 0) return transcript;
  const pred = transcript[transcript.length - 1];
  if (pred.finalText === undefined || pred.steps === undefined) return transcript;
  const need = `${node.id}\n${node.prompt}\n${userTask}`.trim();
  const block = await curatedHandoffBlock(
    pred.node,
    pred.finalText,
    pred.steps,
    need,
    handoffCeiling(deps.budget),
    deps.embed!,
    deps.embedSource,
  );
  if (block === pred.block) return transcript;
  const next = transcript.slice();
  next[next.length - 1] = { ...pred, block };
  return next;
}

/**
 * Bound the running transcript so the handoff can't blow the budget — biased to keep
 * the MOST RECENT structured output (the thing the next node most needs). Newest
 * entries are kept in full, first; once the ceiling is reached, OLDER entries are
 * compacted to their narration line, and the very oldest dropped. Because the newest
 * is packed first, a downstream node ALWAYS sees the prior node's full data block —
 * `budgetMessages`' pinned-head truncation (which cuts the tail) can no longer strip it.
 */
function budgetTranscript(transcript: HandoffEntry[], ceiling: number): HandoffEntry[] {
  const total = transcript.reduce((n, e) => n + estimateTokens(e.block), 0);
  if (total <= ceiling) return transcript;
  const kept: HandoffEntry[] = [];
  let used = 0;
  // Walk newest → oldest; keep full while it fits, else compact to the narration line.
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const e = transcript[i];
    const full = estimateTokens(e.block);
    if (used + full <= ceiling) {
      kept.unshift(e);
      used += full;
      continue;
    }
    const line = `## ${e.node}\n${e.block.split('\n').slice(1, 3).join(' ')}`.trim();
    const lineTokens = estimateTokens(line);
    if (used + lineTokens <= ceiling) {
      kept.unshift({ node: e.node, block: line });
      used += lineTokens;
    }
    // else: too full even for a summary line — drop this and any older entry.
    else break;
  }
  return kept;
}

/**
 * Compose one node's system prompt: preamble + its AGENT.md + running progress.
 * The team progress carries each prior node's narration AND its structured tool
 * outputs (via {@link handoffBlock}); the MOST RECENT entry is listed last (the
 * budgeter pins recent messages, so the thing this node most needs survives).
 */
function nodeSystem(preamble: string, node: IRNode, transcript: HandoffEntry[], budget?: number): string {
  transcript = budgetTranscript(transcript, handoffCeiling(budget));
  const parts = [preamble, '', `--- YOUR ROLE IN THE TEAM: ${node.id} ---`, node.prompt];
  const memory = node.memory?.trim();
  if (memory && memory !== '# Memory') parts.push('', memory);
  if (transcript.length > 0) {
    parts.push('', HANDOFF_DIRECTIVE, '', '--- TEAM PROGRESS SO FAR ---', transcript.map((e) => e.block).join('\n\n'));
  }
  return parts.join('\n');
}

/**
 * Run the whole team over one turn. For each node in {@link nodeOrder}, run the
 * agentic harness with the node's model + narrowed tools + the shared, growing
 * transcript (the `messages` channel, made real). Returns every node's trace and
 * the single user-facing reply (the last node's final text).
 */
export async function runAgenticGraph(
  ir: IR,
  messages: { role: 'user' | 'assistant'; content: string }[],
  deps: AgenticGraphDeps,
): Promise<AgenticGraphResult> {
  const nodeById = new Map(ir.nodes.map((n) => [n.id, n]));
  const order = nodeOrder(ir, new Set(deps.disabled ?? []));

  const runs: NodeRun[] = [];
  let transcript: HandoffEntry[] = [];
  const userTask = lastUserContent(messages);
  for (let orderIdx = 0; orderIdx < order.length; orderIdx += 1) {
    const id = order[orderIdx];
    const node = nodeById.get(id)!;
    // AUTO per-node routing: honor a real pin, else classify (read-only gatherers →
    // fast, judgment/writers → reasoning). Zero LLM cost; surfaced in the drill-down.
    const routed = resolveNodeModel(node, deps);
    const actModel = routed.model;
    // LIVE: announce this node is starting (1-based index over the total path).
    deps.onNodeStart?.({ node: id, index: orderIdx + 1, total: order.length });
    // Per-node step counter for the live stream (1-based).
    let stepIdx = 0;
    // Wrap each node so ONE node's failure is reported as a node-level failure with
    // partial results — never a blank 500 that aborts the whole run. The run stops
    // at the failed node (downstream nodes depend on its output) but every node that
    // ran up to and including it is returned.
    // CONTEXT LIBRARIAN: before composing this node's context, curate the immediate
    // predecessor's material handoff by RELEVANCE to THIS node's need (role + task),
    // so the downstream node keeps the whole material it actually needs within budget
    // rather than a flat keepRows head-truncation. No-op without a live embedder.
    transcript = await curatePredecessor(transcript, node, userTask, deps);
    // Compose the node's system context ONCE so we can both run on it AND capture it
    // as the node's readable `input` for the drill-down (what this agent was given).
    const system = nodeSystem(deps.preamble, node, transcript, deps.budget);
    const input = boundInput(system + renderUserTurn(messages));
    try {
      const result = await runAgentic({
        system,
        userMessages: messages,
        tools: deps.toolSpecsFor(node),
        callTool: deps.callTool,
        llm: deps.llm,
        planModel: deps.reasoningModel,
        actModel,
        maxIterations: deps.maxIterations,
        budget: deps.budget,
        maxOutputTokens: deps.maxOutputTokens,
        // LIVE: forward each governed tool step out to the caller as it happens.
        onStep: deps.onStep ? (step) => { stepIdx += 1; deps.onStep!({ node: id, step, index: stepIdx }); } : undefined,
      });
      const status = nodeStatus(result);
      runs.push({ node: id, model: actModel, tier: routed.tier, tierReason: routed.reason, status, result, input });
      deps.onNodeComplete?.({ node: id, status, finalText: result.finalText });
      // Thread this node's finalText AND its material tool outputs forward, so a
      // downstream node has the actual data (scorecard/rows/metrics) to work from.
      // Keep the RAW finalText/steps too, so the next node can re-render this entry
      // with a relevance-curated material selection (see {@link curatePredecessor}).
      transcript.push({
        node: id,
        block: handoffBlock(node.id, result.finalText, result.steps),
        finalText: result.finalText,
        steps: result.steps,
      });
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      const finalText = `(${id} failed: ${error})`;
      runs.push({
        node: id,
        model: actModel,
        tier: routed.tier,
        tierReason: routed.reason,
        status: 'failed',
        error,
        input,
        result: { plan: '', steps: [], finalText, iterations: 0, toolCallingSupported: true },
      });
      deps.onNodeComplete?.({ node: id, status: 'failed', finalText });
      break;
    }
  }

  const finalText = runs.length > 0 ? runs[runs.length - 1].result.finalText : '(no agents ran)';
  return { path: order, runs, finalText };
}

/**
 * Run EXACTLY ONE node of the team for one turn (the phase-router path). Same
 * injected, governed surface as {@link runAgenticGraph}, but a single `runAgentic`
 * call instead of the six-node walk — ~6× fewer LLM calls per turn, and the one
 * node that runs is chosen by the phase router. `extraGuidance` (the phase's
 * instructions) is appended to the node's system prompt; `onStep` streams each
 * governed tool step so the UI shows live progress, never a silent spinner.
 */
export async function runNode(
  ir: IR,
  nodeId: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  deps: AgenticGraphDeps,
  opts: { extraGuidance?: string; onStep?: (step: import('@/lib/assistant/agentic').AgenticStep) => void } = {},
): Promise<NodeRun> {
  const node = ir.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Unknown team node: ${nodeId}`);
  const system = opts.extraGuidance
    ? `${nodeSystem(deps.preamble, node, [])}\n\n--- THIS TURN ---\n${opts.extraGuidance}`
    : nodeSystem(deps.preamble, node, []);
  const routed = resolveNodeModel(node, deps);
  const actModel = routed.model;
  const result = await runAgentic({
    system,
    userMessages: messages,
    tools: deps.toolSpecsFor(node),
    callTool: deps.callTool,
    llm: deps.llm,
    planModel: deps.reasoningModel,
    actModel,
    maxIterations: deps.maxIterations,
    budget: deps.budget,
    maxOutputTokens: deps.maxOutputTokens,
    onStep: opts.onStep,
  });
  return { node: nodeId, model: actModel, tier: routed.tier, tierReason: routed.reason, status: nodeStatus(result), result, input: boundInput(system + renderUserTurn(messages)) };
}
