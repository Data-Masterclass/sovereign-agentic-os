/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { roleModel } from '@/lib/models/roles';
import { inputBudget, modelContext } from '@/lib/models/context-windows';
import type { CurrentUser } from '@/lib/core/auth';
import { ALL_MCP_TOOLS, isMcpTab, listToolsForRole, toolsForTab, type McpTab } from '@/lib/mcp/server';
import { loadTabContext } from '@/lib/tabs/context';
import { trace as gvTrace } from '@/lib/infra/agent-governed';
import { tabToolExecutor, liteLlmCaller } from '@/lib/assistant/runtime';
import { trackUsage, type ToolSpec, type AgenticStep, type LlmCall, type UsageTracker } from '@/lib/assistant/agentic';
import { loadBuildSpec } from '@/lib/tabs/build-spec';
import { parseSystem, type System } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import { principalFor, runCostUsd, type ModelPrice } from './runtime-contract.ts';
import { effectiveModelPrices } from '@/lib/platform-admin/model-prices';
import { runAgenticGraph, runNode, type AgenticGraphResult, type AgenticGraphDeps } from './agentic-graph.ts';
import { liveEmbedder } from '@/lib/infra/context/librarian-live.ts';
import {
  grantedToolSpecs,
  grantedToolBrief,
  grantedToolExecutor,
  resolveGrantedTools,
  type OsToolDeps,
} from './os-tools.ts';
import {
  preRoute,
  postRoute,
  extractSignals,
  stripControlTags,
  phaseGuidance,
  getSession,
  saveSession,
  lastUserText,
  type Phase,
} from './phase-router.ts';

/**
 * SERVER WIRING for the agentic graph executor. Binds the pure walker
 * (`agentic-graph.ts`) to the SAME governed surface the live software build chat
 * uses — per-user MCP execution via `handleRpc`, the software tab context, and
 * the two LiteLLM tiers — so the Software Delivery Team genuinely builds and
 * requests deploys AS THE SIGNED-IN USER, with no embedded token and no system
 * principal.
 *
 * CONTEXT BUDGETING (the multi-node 400 fix): every node runs the shared
 * `runAgentic` harness, which now bounds each model call to a token budget via
 * `budgetMessages` (`lib/assistant/agentic.ts`) using the model context registry
 * (`lib/models/context-windows.ts`). So the growing team transcript that a later
 * node inherits — the exact thing that compounded past the 200k window and threw
 * the LiteLLM 400 ContextWindowExceededError — is assembled down to a hard input
 * ceiling before it ever reaches the gateway, and each request's `max_tokens` is
 * capped at the model's reserved output. `handoffBudget()` exposes the ceiling
 * used for the between-node hand-off.
 */

/**
 * The input token ceiling for a team turn's between-node hand-off: the SMALLER of
 * the two live model windows (the tools/exec tier and the reasoning tier), so the
 * assembled context fits WHICHEVER model a given node runs on. Passed to the graph
 * executor so each node's growing transcript is assembled down to this bound before
 * it reaches the gateway.
 */
export function handoffBudget(): number {
  return Math.min(inputBudget(roleModel('tools')), inputBudget(roleModel('reasoning')));
}

// The OS rules preamble every node is grounded in (mirrors the tab assistant's).
const OS_RULES = [
  'You are one agent in a governed Software Delivery Team inside the Sovereign',
  'Agentic OS — a sovereign platform where nothing leaves the tenant boundary.',
  '- Every tool call runs under YOUR delegated identity: OPA-authorized, role-gated',
  '  and Langfuse-audited. If a tool is denied, explain it plainly; do not retry blindly.',
  '- Deploy is a Builder-REVIEWED draft, never auto-live: request_deploy opens a review',
  '  gate; it does not go live until a human Builder approves it.',
  '- Consume granted resources by reference via the use_* tools, never a raw secret.',
  '- Prefer real action over description: use your tools to actually do the work.',
].join('\n');

export function preamble(): string {
  const spec = loadBuildSpec();
  return [
    OS_RULES,
    '',
    '--- SOFTWARE TAB CONTEXT (authoritative environment reference) ---',
    loadTabContext('software') || '(no tab context available)',
    ...(spec ? ['', '--- BUILD SPEC (canonical — the exact template, tool sequence, governance) ---', spec] : []),
  ].join('\n');
}

/** Role-scope the software tools once, then narrow per node to its tool list. */
function toolSpecsFactory(user: CurrentUser): (nodeTools: string[]) => ToolSpec[] {
  const byName = new Map(
    listToolsForRole(user.role, toolsForTab('software')).map((t) => [
      t.name,
      { name: t.name, description: t.description, inputSchema: t.inputSchema as ToolSpec['inputSchema'] },
    ]),
  );
  return (nodeTools) =>
    nodeTools.map((n) => byName.get(n)).filter((s): s is ToolSpec => s !== undefined);
}

// The OS-wide rules preamble for a GENERAL (any-tab) agentic-os team — tab-agnostic
// (the software team gets the richer, software-flavoured `OS_RULES`/`preamble()`).
const OS_TEAM_RULES = [
  'You are one agent in a governed team inside the Sovereign Agentic OS — a sovereign',
  'platform where nothing leaves the tenant boundary.',
  '- Every tool call runs under the RUNNING USER\'s delegated identity: OPA-authorized,',
  '  role-gated and Langfuse-audited. If a tool is denied or held for approval, explain',
  '  it plainly; do not retry blindly.',
  '- You may use ONLY the tools you are granted; consume granted resources by reference,',
  '  never a raw secret.',
  '- Prefer real action over description: use your tools to actually do the work.',
  '- Aggregate/compute with a SINGLE SQL query (GROUP BY / window functions) rather',
  '  than fetching raw rows to "compute manually"; never re-run a query whose result',
  '  you already have — reason over the result you already fetched.',
].join('\n');

/** The distinct OS tabs a system's granted MCP tools live under (for context grounding). */
function grantedTabs(sys: System): McpTab[] {
  const names = new Set(resolveGrantedTools(sys).mcpNames);
  const tabs = new Set<McpTab>();
  for (const t of ALL_MCP_TOOLS) {
    if (names.has(t.name) && isMcpTab(t.tab)) tabs.add(t.tab);
  }
  return [...tabs];
}

/**
 * The tool-FREE purpose line of a tab's CONTEXT.md — the `**Purpose:** …` sentence.
 * It grounds the agent in what the tab is FOR without listing any tool the system
 * may not hold (the CONTEXT.md tool catalog + golden paths do that, and are the
 * exact leak that advertised ungranted tools). Returns '' when no Purpose line is
 * present, so an ungrounded tab simply contributes nothing.
 */
function tabPurpose(tab: McpTab): string {
  const ctx = loadTabContext(tab);
  const line = ctx.split('\n').find((l) => l.trim().startsWith('**Purpose:**'));
  if (!line) return '';
  return line.replace(/\*\*/g, '').trim();
}

/**
 * The GRANT-SCOPED context brief: the EXACT governed resource ids the system may use, per
 * kind, built straight from `system.grants` (by run time these are concrete ids — folder
 * grants are already expanded upstream by `resolveFolderGrantsForRun`). It is the data-plane
 * counterpart to {@link grantedToolBrief}: the tool brief says which TOOLS you may call, this
 * says which RESOURCES you may pass them. Empty ⇒ '' (contributes nothing). Ids only (no
 * names/columns — the agent resolves those via its granted get_* discovery companion).
 */
function grantedContextBrief(sys: System): string {
  const g = sys.grants;
  const rows: string[] = [];
  const add = (label: string, items: { id?: string }[] | undefined) => {
    const ids = (items ?? []).map((i) => i.id).filter((id): id is string => !!id && id.length > 0);
    if (ids.length > 0) rows.push(`- ${label}: ${ids.join(', ')}`);
  };
  add('datasets', g.data);
  add('knowledge', g.knowledge);
  add('files', g.files);
  add('metrics', g.metrics);
  add('connections', g.connections);
  add('plan (pillars / bets / operating-manual)', g.plan);
  if (rows.length === 0) return '';
  return [
    'These are the ONLY governed resources you may act on. A discovery/list tool may return',
    'OTHER ids that exist in the domain — you are NOT authorized to use them and any action on',
    'them is DENIED. Use ONLY the ids below (resolve their schema with your granted get_* tool):',
    '',
    ...rows,
  ].join('\n');
}

/**
 * The preamble for a general agentic-os team: OS rules + a tool-free PURPOSE line for
 * each tab the grants touch + the GRANT-SCOPED tool brief (exactly the tools this
 * system may call — {@link grantedToolBrief}). It deliberately does NOT inject the
 * full per-tab CONTEXT.md tool catalog or golden paths: those enumerate EVERY tool of
 * the tab regardless of grants, which advertised ungranted tools (build_gold_join,
 * run_quality_checks, index_knowledge, create_software …) to the model and led it to
 * attempt them. Discovery is now scoped to grants at BOTH the manifest and the prompt.
 * The build spec is injected ONLY when `create_software` is actually granted (it names
 * that tool as the entry point). `user` role-scopes the brief so the prompt can never
 * name a tool above the runner's role.
 */
export function osPreamble(user: CurrentUser, sys: System): string {
  const tabs = grantedTabs(sys);
  const parts = [OS_TEAM_RULES];
  const purposes = tabs.map((tab) => tabPurpose(tab)).filter((p) => p.length > 0);
  if (purposes.length > 0) {
    parts.push('', '--- WORKSPACE (the OS areas your grants touch) ---', ...purposes.map((p) => `- ${p}`));
  }
  // GRANTED CONTEXT — the EXACT resource ids this system may touch. A discovery tool
  // (list_datasets/list_knowledge/…) runs as the human owner and can surface OTHER items
  // in the domain the system was NOT granted; calling an action tool on one of those is
  // DENIED by OPA. Naming the authorized ids here — the data-plane counterpart to the
  // grant-scoped tool brief — stops the model wandering onto ungranted context and then
  // hitting a denial. Fail-open on shape: absent grants contribute nothing.
  const ctx = grantedContextBrief(sys);
  if (ctx) parts.push('', '--- YOUR GRANTED CONTEXT (the ONLY resource ids you may use) ---', ctx);
  parts.push('', '--- YOUR GRANTED TOOLS (your complete, authoritative toolset) ---', grantedToolBrief(user, sys));
  // The build spec names `create_software` as its entry point — inject it only when
  // that tool is genuinely granted, so it never advertises an ungranted capability.
  const granted = new Set(resolveGrantedTools(sys).mcpNames);
  if (granted.has('create_software')) {
    const spec = loadBuildSpec();
    if (spec) parts.push('', '--- BUILD SPEC (canonical — the exact template, tool sequence, governance) ---', spec);
  }
  return parts.join('\n');
}

export type RunOsTeamInput = {
  user: CurrentUser;
  yaml: string;
  /** The system id — for the `os-<id>` OPA pre-gate + trace attribution. */
  systemId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  disabledAgents?: string[];
  maxIterations?: number;
  /** Injected in tests; defaults to the live LiteLLM caller. */
  llm?: LlmCall;
  /** Injected in tests; the governed executor deps (authorize/enqueue/handleRpc/trace). */
  toolDeps?: OsToolDeps;
  /**
   * LIVE PROGRESS hooks (optional) — forwarded straight to the graph executor so the
   * run route can stream what is happening right now. Absent → the team runs silently
   * (the fire-and-wait path). See {@link AgenticGraphDeps}.
   */
  onNodeStart?: AgenticGraphDeps['onNodeStart'];
  onStep?: AgenticGraphDeps['onStep'];
  onNodeComplete?: AgenticGraphDeps['onNodeComplete'];
};

/**
 * Run ANY agentic-os team (`isAgenticOsTeam`) over one turn, live, in-process, as
 * the RUNNING USER. Generalises the former `runAgenticTeam` (software-only) to the
 * whole governed OS MCP toolset: per node, the granted, role-scoped tool schemas
 * (`grantedToolSpecs`) go to LiteLLM, and every tool call is dispatched through
 * `grantedToolExecutor(user, sys, systemId)` → `handleRpc(user, …)` — the exact
 * governed door the external MCP server uses, under `user:<id>`, never a service
 * principal. Software-only teams are a strict subset, so their behaviour is
 * preserved. The last node's narration is the single user-facing reply.
 */
export async function runOsTeam(input: RunOsTeamInput): Promise<AgenticGraphResult> {
  const sys = parseSystem(input.yaml);
  const ir = compile(sys);
  // Resolve the price book ONCE per run start (admin-saved prices over the env
  // seed; fail-soft) — `runCostUsd` stays pure and the summary trace below prices
  // the run against the book that was current when it started.
  const prices = await effectiveModelPrices();
  // Live embedder for the Context Librarian handoff: the predecessor's material is
  // kept whole by RELEVANCE to the downstream node's need. Degrades to the keepRows
  // handoff automatically when the embedder falls back to the offline hash.
  const embedder = liveEmbedder();
  // Aggregate token usage across EVERY model call this run makes (plan + act on
  // every node) — the source for the Monitoring run-summary trace below.
  const tracked = trackUsage(input.llm ?? liteLlmCaller());
  const result = await runAgenticGraph(ir, input.messages, {
    llm: tracked.llm,
    toolSpecsFor: (node) => grantedToolSpecs(input.user, sys, node.tools),
    callTool: grantedToolExecutor(input.user, sys, input.systemId, input.toolDeps),
    embed: embedder.embed,
    embedSource: embedder.lastSource,
    preamble: osPreamble(input.user, sys),
    reasoningModel: roleModel('reasoning'),
    // ACT/tool-calling fallback model (a per-agent pin still wins). The `tools`
    // role defaults to Qwen for clean OpenAI tool_calls; the harmony-format
    // light default mangles tool names. Admin-overridable.
    execModel: roleModel('tools'),
    // Each TEAM node gets the higher per-node cap (an evaluator/recommender doing
    // per-campaign work needs more than the single-agent 20). Caller override wins.
    maxIterations: input.maxIterations ?? config.agentTeamNodeMaxSteps,
    // GLOBAL ceiling for the whole team run — clamps nodes×per-node so a large team
    // can't run away on the shared LLM pool (or time out). Each node draws from it.
    maxRunSteps: config.agentTeamRunMaxSteps,
    // Bound every node to the smaller live window; cap each node's own output.
    budget: handoffBudget(),
    maxOutputTokens: modelContext(roleModel('tools')).reservedOutput,
    disabled: input.disabledAgents,
    // LIVE PROGRESS: forwarded to the streaming run route (no-op when unset).
    onNodeStart: input.onNodeStart,
    onStep: input.onStep,
    onNodeComplete: input.onNodeComplete,
  });
  emitRunSummaryTrace(input, result, tracked, prices);
  return result;
}

/** Upper bound on the prompt echoed into the run-summary trace input. */
const RUN_TRACE_PROMPT_MAX = 500;

/**
 * One run-summary trace so Monitoring attributes the run's tokens/cost to this
 * system (mirrors `runSystem`'s summary in server.ts — the in-process agentic path
 * was silently untraced, leaving the tiles at tokens=0). MUST use principalFor
 * (`os-<id>`) — the telemetry batch only groups `os-` principals. Tokens are the
 * run's AGGREGATE reported usage; when NO model call reported usage they stay
 * undefined (never fabricated). Cost is priced ONLY from the explicit price book
 * (admin-saved prices over the env MODEL_PRICES_JSON seed, resolved at run start)
 * over the models this run ACTUALLY called (unpriced ⇒ undefined ⇒ "—", never 0).
 * Fire-and-forget: telemetry never blocks or fails the run.
 */
function emitRunSummaryTrace(
  input: RunOsTeamInput,
  result: AgenticGraphResult,
  tracked: UsageTracker,
  prices: Readonly<Record<string, ModelPrice>>,
): void {
  const usage = tracked.usage();
  const prompt = lastUserText(input.messages);
  // Tests inject their trace spy via toolDeps (the same seam the executor uses).
  const traceFn = input.toolDeps?.trace ?? gvTrace;
  void traceFn({
    principal: `${principalFor(input.systemId)}:run`,
    tool: 'generate',
    input: { prompt: prompt.length > RUN_TRACE_PROMPT_MAX ? `${prompt.slice(0, RUN_TRACE_PROMPT_MAX)}…` : prompt },
    output: { reachedEnd: result.reachedEnd, path: result.path },
    decision: 'allow',
    tokens: usage?.total,
    costUsd: runCostUsd(usage, tracked.models(), prices),
  });
}

export type PhaseTurnResult = {
  /** The user-facing narration (control tags stripped). */
  reply: string;
  /** The phase the session is now in (after this turn advanced it). */
  phase: Phase;
  /** The role-agent that ran this turn. */
  role: string;
  /** The app id, once the builder has created it (persisted in the session). */
  appId: string | null;
  /** The governed tool steps this turn took (for the UI). */
  steps: { tool: string; isError: boolean }[];
};

export type RunPhaseTurnInput = {
  user: CurrentUser;
  yaml: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Streamed after each governed tool step so the UI shows live progress. */
  onStep?: (step: AgenticStep) => void;
};

/**
 * ONE TURN of the interactive builder: the phase router picks the single
 * role-agent to run (given the persisted session + the user's latest message),
 * runs it live as the signed-in user (~2-8 LLM calls, not ~42), advances the
 * phase from the run's signals, and persists the session (globalThis-pinned per
 * user). This is what the Software-tab Team panel drives — questions genuinely
 * gate building, and feedback loops as diff commits.
 */
export async function runPhaseTurn(input: RunPhaseTurnInput): Promise<PhaseTurnResult> {
  const key = input.user.id;
  const session = getSession(key);
  const { phase, role } = preRoute(session, lastUserText(input.messages));

  const ir = compile(parseSystem(input.yaml));
  const specsFor = toolSpecsFactory(input.user);
  const run = await runNode(
    ir,
    role,
    input.messages,
    {
      llm: liteLlmCaller(),
      toolSpecsFor: (node) => specsFor(node.tools),
      callTool: tabToolExecutor(input.user, 'software'),
      preamble: preamble(),
      reasoningModel: roleModel('reasoning'),
      // Tool-calling fallback model (per-agent pin still wins) — Qwen by default
      // for clean OpenAI tool_calls, not the harmony-format light model.
      execModel: roleModel('tools'),
      // Bound this node to the smaller live window; cap its own output.
      budget: handoffBudget(),
      maxOutputTokens: modelContext(roleModel('tools')).reservedOutput,
    },
    { extraGuidance: phaseGuidance(phase, session.appId), onStep: input.onStep },
  );

  const signals = extractSignals(run.result);
  const nextPhase = postRoute(phase, signals);
  const appId = signals.appId ?? session.appId;
  saveSession(key, {
    phase: nextPhase,
    appId,
    planApproved: session.planApproved || phase === 'build',
    updatedAt: session.updatedAt,
  });

  return {
    reply: stripControlTags(run.result.finalText) || '(the team produced no narration)',
    phase: nextPhase,
    role,
    appId,
    steps: run.result.steps.map((s) => ({ tool: s.tool, isError: s.isError })),
  };
}
