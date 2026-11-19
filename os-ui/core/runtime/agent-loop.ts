/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import type { CurrentUser } from '@core/kernel/auth';
import {
  handleRpc,
  ALL_MCP_TOOLS,
  toolsForTab,
  listToolsForRole,
  isMcpTab,
  type McpTab,
} from '@core/mcp/server';
import { loadTabContext, tabTitle } from '@core/tabs-meta/context';
import { buildInstructions } from '@core/mcp/instructions';
import { runAgentic, type AgenticResult, type LlmCall, type ToolExecutor, type ToolSpec } from '@core/runtime/agentic';
import { ungatedByRollbackFlag, type GatedToolExecutor } from '@core/runtime/confirm-gate';
import {
  ASK_CONFIRM_GATE_FLAG,
  askClosedReason,
  askConfirmGate,
  askConfirmGateEnabled,
  askPendingCards,
  confirmationOutcomesBlock,
  prepareAskConfirmations,
  resolveAskConversationId,
} from '@core/runtime/ask-confirm';
import type { ConfirmCard } from '@core/runtime/confirm-card';
import { ASK_RULES_BLOCK } from '@core/runtime/ask-rules';
import { parseArtifacts, truncationBanner, type ChatArtifact } from '@core/runtime/chat-artifacts';
import { WRITE_TOOL_NAMES } from '@core/mcp/write-tool-meta';
import { liteLlmCaller } from '@core/runtime/runtime';
import { resolveAssistantModelId } from '@core/runtime/complete';
import { inputBudget, modelContext } from '@core/models/context-windows';
import { renderPageContext, type PageContext } from '@core/runtime/page-context';

/**
 * THE ONE OVERARCHING SOVEREIGN OS ASSISTANT (server wiring).
 *
 * A single, globally-available assistant that is present on every tab. It is
 * CONTEXT-AWARE of the tab the user is on (its CONTEXT.md is injected and its
 * tools are surfaced first) while carrying OVERARCHING OS context — it can reach
 * EVERY governed MCP tool across every tab.
 *
 * It is an MCP CLIENT of the OS's OWN MCP server: it gets all information and
 * triggers all actions through the EXACT SAME governed dispatch (`handleRpc`)
 * that external clients (Claude Desktop) use, under the signed-in user's
 * delegated identity. So it inherits identical guardrails — role floor,
 * approvals, OPA/RLS, Langfuse audit. There is NO ungoverned side-channel.
 *
 * It reuses the pure PLAN→ACT harness (`agentic.ts`) and the governed LiteLLM
 * caller (`runtime.ts`), and runs on the ONE assistant model
 * (`resolveAssistantModelId()` → `sovereign-default`).
 */

/**
 * Route → MCP tab. The app's nav hrefs don't all match the MCP tab ids (Files
 * lives at `/unstructured`), so map explicitly. Routes
 * with no governed tool surface (Home, Settings, Admin…) return null —
 * the assistant is still fully available, just without a tab lens.
 */
const PATH_TAB: Record<string, McpTab> = {
  data: 'data',
  knowledge: 'knowledge',
  agents: 'agents',
  software: 'software',
  unstructured: 'files',
  metrics: 'metrics',
  dashboards: 'dashboards',
  connections: 'connections',
  governance: 'governance',
  monitoring: 'monitoring',

};

/** Resolve the current MCP tab from a browser pathname, or null (no tab lens). */
export function mcpTabForPath(path: string | null | undefined): McpTab | null {
  if (!path) return null;
  const seg = path.replace(/^\/+/, '').split('/')[0] ?? '';
  const tab = PATH_TAB[seg];
  if (tab && isMcpTab(tab)) return tab;
  return null;
}

// OS-wide grounding every turn is anchored in. Short, honest, governance-first.
const OS_RULES_HEAD = [
  'You are the Sovereign OS Assistant — the single, overarching assistant of the',
  'Sovereign Agentic OS, a governed, in-tenant platform where nothing leaves the',
  'tenant boundary. You are present on every tab and help with whatever the user',
  'is doing there, while understanding the whole OS.',
  '',
  'HOW YOU ACT (non-negotiable): you get all information and take all actions by',
  "calling the OS's own governed MCP tools. Every tool call runs under the user's",
  'delegated identity through the SAME governed dispatch external MCP clients use —',
  'OPA-authorized, role-gated, approval-gated and Langfuse-audited. You have no',
  'privileged side-channel.',
  '',
  'ROLES (4 ranks): creator < builder < domain admin < admin. Creators build in',
  'their own domain; promoting/publishing a shared asset is Builder+; certifying to',
  'the marketplace is Admin. Deploy is a Builder-REVIEWED draft (request_deploy',
  'opens a review gate) — never auto-live.',
  '',
  'BE HONEST: if a tool is blocked by governance (role or approval), say so plainly',
  '— name the role required — and do NOT pretend you performed the action. Prefer',
  'real tool calls over description. Start from `whoami` / `list_capabilities` when',
  'you are unsure what you can do.',
].join('\n');

/**
 * HOW CHANGES WORK, with the confirmation gate ON (the default). This is UX guidance — it makes
 * the conversation smooth — and it is NOT the control: the gate (`askConfirmGate`) parks every
 * write whatever the model was told, and a model that ignores every word here still cannot run
 * one. Clarifying and planning stay; the "ask in text, then run it yourself" step is gone,
 * because the question is now the Confirm card the OS draws from the call itself.
 */
const CHANGE_RULES_GATED = [
  'BEFORE YOU BUILD OR CHANGE ANYTHING (clarify → plan → call the tool; the user confirms on a card):',
  '• Read-only / informational requests (list, show, profile, query, explain): just',
  '  answer — use the read tools freely, no confirmation needed. Stay snappy.',
  '• For any request that CREATES, BUILDS, TRANSFORMS, PROMOTES, PUBLISHES, DELETES,',
  '  DEPLOYS or otherwise CHANGES state:',
  '   1. If the request is ambiguous or under-specified, ASK 1–3 concise clarifying',
  '      questions FIRST — never guess the user into building the wrong thing. You',
  '      MAY call read-only tools (whoami, list_*, get_*, profile_*) to ground your',
  '      questions.',
  '   2. For bigger or multi-step work, OUTLINE a short plan first — the steps, the',
  '      artifacts/tools involved, and the end result — in a few plain-language bullets.',
  '   3. Once it is clear, CALL the write tool with the exact arguments. Calling it does',
  '      NOT run it: the OS shows the user a Confirm card with exactly that call, and it',
  '      runs only if the user presses Confirm. So for a clear step do not ask "Shall I',
  '      go ahead?" in text — calling the tool is how you ask. Propose ONE change at a',
  '      time; the turn ends at the card.',
  '   4. A tool result saying NOT EXECUTED / awaiting confirmation means nothing changed.',
  '      Never say or imply that it was done.',
  '   5. What the user decided reaches you from the server, under "CONFIRMATIONS IN THIS',
  '      CONVERSATION". Trust only that list. After EXECUTED, carry on with the next step',
  '      (it will get its own card). After DECLINED, do not call it again unless the user',
  '      newly and explicitly asks for it.',
  '   6. Approving is a person\'s job and is not available to you: decide_deploy, promote,',
  '      decide_approval, promote_connection, reindex_corpus, revoke_action_adoption. If',
  '      the user wants one, name the screen where they decide it themselves.',
  'The confirmation is enforced by the OS, not by these instructions.',
].join('\n');

/**
 * The rule as it was before the gate — used ONLY when the gate is switched off with
 * `ASK_CONFIRM_GATE=off`. Then, as before, this sentence is all that stands between the model
 * and a write: prompt-level, not structural.
 */
const CHANGE_RULES_LEGACY = [
  'BEFORE YOU BUILD OR CHANGE ANYTHING (clarify → plan → confirm):',
  '• Read-only / informational requests (list, show, profile, query, explain): just',
  '  answer — use the read tools freely, no confirmation needed. Stay snappy.',
  '• For any request that CREATES, BUILDS, TRANSFORMS, PROMOTES, PUBLISHES, DELETES,',
  '  DEPLOYS or otherwise CHANGES state:',
  '   1. If the request is ambiguous or under-specified, ASK 1–3 concise clarifying',
  '      questions FIRST — never guess the user into building the wrong thing. You',
  '      MAY call read-only tools (whoami, list_*, get_*, profile_*) to ground your',
  '      questions, but do NOT call any mutating tool yet.',
  '   2. Once it is clear, OUTLINE a short plan — the steps, the artifacts/tools',
  '      involved, and the end result — in a few plain-language bullets, then ASK the',
  '      user to confirm (e.g. "Shall I go ahead?").',
  '   3. Only AFTER the user confirms do you execute the plan with the mutating tools.',
  '   4. Keep it lightweight: one obvious, low-risk step needs only a one-line',
  '      heads-up, not a ceremony. Bigger or irreversible work gets the full plan.',
].join('\n');

/** The whole rules block for one mode of the gate. */
function osRules(confirmGate: boolean): string {
  return [
    OS_RULES_HEAD,
    '',
    confirmGate ? CHANGE_RULES_GATED : CHANGE_RULES_LEGACY,
    '',
    OS_RULES_TAIL,
  ].join('\n');
}

const OS_RULES_TAIL = [
  // C2 / C5 / C6 — the semantic-layer-first, truncation-honesty and ad-hoc-labelling
  // rules, imported from the ONE module the four MCP guides also carry verbatim so the
  // in-app assistant and an external MCP client are told the same thing.
  ASK_RULES_BLOCK,
].join('\n');

/**
 * The system prompt: OS overview + current-tab context + governance note, plus the
 * optional PAGE CONTEXT (the exact screen/artifact open right now). The page-context
 * block only appears when the surface published one — otherwise the prompt is
 * byte-for-byte today's, so the assistant's behavior is unchanged (still asks for an
 * id when it truly has none). Context only ENRICHES.
 */
export function osAssistantSystem(
  tab: McpTab | null,
  page?: PageContext | null,
  opts: {
    /** Which change rules to carry. Defaults to the live flag (ON unless rolled back). */
    confirmGate?: boolean;
    /** The server-authored confirmation outcomes for this conversation, when there are any. */
    confirmations?: string | null;
  } = {},
): string {
  const parts = [osRules(opts.confirmGate ?? askConfirmGateEnabled()), '', '--- OS ORIENTATION ---', buildInstructions()];
  if (tab) {
    parts.push(
      '',
      `--- CURRENT TAB: ${tabTitle(tab)} (the user is on this tab right now) ---`,
      'Help with this tab first; its tools are listed before the rest. You may still',
      'reach any other governed tool across the OS when the task calls for it.',
      loadTabContext(tab) || '(no tab context available)',
    );
  } else {
    parts.push(
      '',
      '--- CURRENT TAB: none (an overview page) ---',
      'No single tab is in focus; help across the whole OS using any governed tool.',
    );
  }
  const pageBlock = renderPageContext(page);
  if (pageBlock) parts.push('', pageBlock);
  if (opts.confirmations) parts.push('', opts.confirmations);
  return parts.join('\n');
}

/**
 * Every governed tool the caller may use, role-scoped, with the current tab's
 * tools ordered FIRST so the model reaches for them preferentially — but the full
 * registry is present, so the assistant can act on any tab.
 *
 * With the confirmation gate on (the default), the tools Ask refuses outright — the approvals,
 * `AGENT_FORBIDDEN_TOOLS` — are not offered either: a model will try whatever it can see. A
 * person still has every one of them in the UI and in their own MCP client.
 */
export function osToolSpecs(
  user: CurrentUser,
  tab: McpTab | null,
  opts: { confirmGate?: boolean } = {},
): ToolSpec[] {
  const gated = opts.confirmGate ?? askConfirmGateEnabled();
  const all = listToolsForRole(user.role, ALL_MCP_TOOLS)
    .filter((t) => !gated || askClosedReason(t.name) === null)
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as ToolSpec['inputSchema'],
    }));
  if (!tab) return all;
  const tabNames = new Set(toolsForTab(tab).map((t) => t.name));
  const first = all.filter((t) => tabNames.has(t.name));
  const rest = all.filter((t) => !tabNames.has(t.name));
  return [...first, ...rest];
}

/**
 * A governed tool executor: dispatch through the SAME `handleRpc` the MCP HTTP
 * route uses, over the FULL registry (no per-tab scoping — the assistant is
 * overarching). handleRpc re-checks the role floor and the underlying governed
 * function (OPA + Langfuse) is the real authority, so this never bypasses
 * governance. A denial comes back as an honest `isError` result, not a throw.
 */
/**
 * The ONE hop that carries a governed tool's typed payload from the MCP dispatcher onto the
 * chat turn (C5/C9). Exported so the guard test can pin it directly: the model still sees
 * the flattened text, but the truncation fields, the SQL and the citation travel
 * STRUCTURALLY to the surface, so a clipped result can never reach the user as a confident
 * total merely because the model omitted to mention the clipping.
 *
 * An `isError` result yields NOTHING: a denial carries `{ error }` as its structuredContent
 * and must never be rendered as if it were data.
 */
export function artifactsFromToolResult(result: {
  structuredContent?: unknown;
  isError?: boolean;
}): ChatArtifact[] {
  if (result.isError) return [];
  return parseArtifacts(result.structuredContent);
}

/**
 * The marker PREPENDED to a tool result's text when the projected artifact says the result
 * was clipped (review H-2).
 *
 * Why the front and not the end. The tool result reaches the model as pretty-printed JSON,
 * and the truncation keys sit near the END of that object. The context assembler bounds an
 * oversized tool result with `truncateToTokens`, which KEEPS THE HEAD — so on exactly the
 * results most likely to be clipped (the big ones), the notice that they were clipped is the
 * first thing dropped. A model that never saw `"truncated": true` cannot obey the rule that
 * forbids totalling it. Putting the sentence first makes it the last thing to be cut.
 *
 * Returns null when nothing was clipped — an unconditional banner would train the model to
 * ignore it.
 */
export function truncationMarkerFor(artifacts: ChatArtifact[]): string | null {
  for (const a of artifacts) {
    if (a.kind !== 'table' || !a.truncated) continue;
    const sentence = truncationBanner(a);
    if (sentence) return `⚠ TRUNCATED: ${sentence}`;
  }
  return null;
}

/**
 * The exact `role: 'tool'` text the model is handed for one governed tool call: the
 * clipping notice first (see {@link truncationMarkerFor}), then the tool's own output.
 * Exported so the guard test asserts the REAL composition rather than re-implementing it.
 */
export function composeToolText(artifacts: ChatArtifact[], body: string): string {
  const marker = truncationMarkerFor(artifacts);
  const text = body || '(no output)';
  return marker ? `${marker}\n\n${text}` : text;
}

/** The governed dispatch an executor calls. Injectable so a test can observe what reaches it. */
export type RpcDispatch = typeof handleRpc;

export function osToolExecutor(user: CurrentUser, sink?: ChatArtifact[], dispatch: RpcDispatch = handleRpc): ToolExecutor {
  return async (name, args) => {
    const res = await dispatch(user, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (res?.error) return { text: `Error: ${res.error.message}`, isError: true };
    const result = (res?.result ?? {}) as {
      content?: { text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    // C5 / C9 — the tool's OWN `structuredContent` is the artifact payload (D14). The
    // model still sees the flattened text, but the TRUNCATION fields, the SQL and the
    // citation travel structurally to the surface alongside it, so a clipped result can
    // never reach the user as a confident total just because the model omitted to mention
    // it. One serialiser: the drawer renders the identical payload an external MCP client
    // receives. A denial (`isError`) carries `{ error }`, which yields no artifacts.
    const artifacts = artifactsFromToolResult(result);
    if (sink) {
      for (const artifact of artifacts) sink.push(artifact);
    }
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
    // H-2 — the clipping notice goes FIRST, ahead of the JSON, so the head-keeping context
    // bound cannot cut it off the one kind of result it matters for.
    return { text: composeToolText(artifacts, text), isError: !!result.isError };
  };
}

/**
 * THE EXECUTOR ASK THE OS HANDS THE HARNESS — the one place its gate is chosen.
 *
 * Gate ON (default): `askConfirmGate` around {@link osToolExecutor}. A confirm-free tool runs; an
 * approval is refused; every other call is parked for the user's own Confirm and reaches the
 * dispatcher only from `POST /api/assistant/confirm`, through this same inner executor, as the
 * same user — so the role floor, OPA and any downstream approval apply again at that moment.
 *
 * Gate OFF (`ASK_CONFIRM_GATE=off`, the documented rollback): the previous behaviour, a
 * pass-through — named `ungatedByRollbackFlag` so it is pinned and searchable.
 */
export function askToolExecutor(
  user: CurrentUser,
  opts: {
    conversationId: string;
    traceId?: string;
    sink?: ChatArtifact[];
    dispatch?: RpcDispatch;
    /** Defaults to the live flag. */
    confirmGate?: boolean;
  },
): GatedToolExecutor {
  const inner = osToolExecutor(user, opts.sink, opts.dispatch);
  if (!(opts.confirmGate ?? askConfirmGateEnabled())) return ungatedByRollbackFlag(inner, ASK_CONFIRM_GATE_FLAG);
  return askConfirmGate(inner, { userId: user.id, conversationId: opts.conversationId, traceId: opts.traceId });
}

/** The registry description of a tool, for the Confirm card. */
function toolDescription(name: string): string | undefined {
  return ALL_MCP_TOOLS.find((t) => t.name === name)?.description;
}

export type RunOsAssistantInput = {
  user: CurrentUser;
  /** The tab the user is currently on, or null (overview page / no tool surface). */
  tab: McpTab | null;
  /** The exact screen/open-artifact snapshot the surface published, if any. Folded
   *  into the system prompt so the open artifact is the default subject. Optional —
   *  absent means "no page context", and the assistant behaves as before. */
  page?: PageContext | null;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /**
   * The conversation this turn belongs to — what a confirmation, its outcome and an "Allow for
   * this conversation" grant are scoped to (together with the user). The route passes the id
   * the client echoed, already validated; absent, a fresh one is minted and returned.
   */
  conversationId?: string;
  maxIterations?: number;
  /**
   * C1 — the id this TURN is traced under. Every model call the turn makes nests inside
   * it, so one turn is ONE Langfuse trace instead of N orphans, and it is also the run
   * dimension on the LiteLLM tags (`run:<id>`). Server-minted per turn; a caller may
   * inject one (tests, and the durable-thread work that comes later) but the browser
   * never supplies it — a client-chosen trace id would let one user write into another
   * user's trace.
   */
  traceId?: string;
  /** Injected in tests; defaults to the live governed LiteLLM caller. */
  llm?: LlmCall;
};

export type OsAssistantResult = AgenticResult & {
  tab: McpTab | null;
  /** The typed artifacts the governed tools produced this turn, in call order. */
  artifacts: ChatArtifact[];
  /** The Langfuse trace (= turn) id every model call on this turn was logged under. */
  traceId: string;
  /** The conversation id to echo on the next turn (minted here when none came in). */
  conversationId: string;
  /** The Confirm cards for what this turn parked — built from the server's record of each call. */
  pendingCards: ConfirmCard[];
};

/**
 * The LiteLLM `tab:` dimension for the Ask-the-OS surface. Deliberately NOT the tab lens
 * the user happens to be standing on: before this, an Ask-the-OS turn on the Data tab was
 * tagged `tab:data` and was indistinguishable from the Data tab's own model calls, so the
 * cost of the flagship chat surface could not be read back at all. The tab lens is still
 * in the system prompt and in the response's `tab` field.
 */
export const ASK_COST_TAB = 'ask';

/** A fresh turn id. `randomUUID` where available, else a timestamped random fallback. */
function mintTraceId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return `ask-${c.randomUUID()}`;
  return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Run one PLAN→ACT turn for the overarching OS assistant and return the full
 * trace (plan, every governed tool call, final answer). Production runs on the
 * ONE assistant model; a missing model throws the honest AssistantNotConfigured
 * error via `resolveAssistantModelId()`.
 */
export async function runOsAssistant(input: RunOsAssistantInput): Promise<OsAssistantResult> {
  const injected = input.llm;
  const traceId = input.traceId || mintTraceId();
  const artifacts: ChatArtifact[] = [];
  // Production: the ONE assistant model for both plan + act. Tests inject `llm`
  // and own model selection, so the config tier ids are opaque placeholders.
  const assistantId = injected ? config.litellmExecModel : resolveAssistantModelId();
  const ctx = modelContext(assistantId);
  const conversationId = resolveAskConversationId(input.conversationId);
  // ONE reading of the flag per turn, so the prompt, the offered tools and the executor agree.
  const confirmGate = askConfirmGateEnabled();
  if (confirmGate) await prepareAskConfirmations();
  const result = await runAgentic({
    system: osAssistantSystem(input.tab, input.page, {
      confirmGate,
      // What the user decided so far — read from the store, never from the chat text.
      confirmations: confirmGate ? confirmationOutcomesBlock(input.user.id, conversationId) : null,
    }),
    userMessages: input.messages,
    tools: osToolSpecs(input.user, input.tab, { confirmGate }),
    // THE CONFIRMATION GATE: a write the model calls is parked for the user's own Confirm; an
    // approval is refused. (`ASK_CONFIRM_GATE=off` falls back to the old pass-through.)
    callTool: askToolExecutor(input.user, { conversationId, traceId, sink: artifacts, confirmGate }),
    // C1 — ONE trace per turn: the plan call, every act iteration and the cap synthesis all
    // nest under this turn's id instead of each creating its own unlinked Langfuse trace.
    observe: { traceId },
    // A3: attributed — the user, their active domain, the Ask surface and this turn
    // (never the master key).
    llm: injected ?? liteLlmCaller({
      userId: input.user.id,
      domain: input.user.activeDomain ?? input.user.domains[0] ?? 'none',
      tab: ASK_COST_TAB,
      runId: traceId,
    }),
    planModel: injected ? config.litellmReasoningModel : assistantId,
    actModel: assistantId,
    maxIterations: input.maxIterations ?? config.assistantMaxSteps,
    budget: inputBudget(assistantId),
    maxOutputTokens: ctx.reservedOutput,
    // A FAILED write must never be re-fired byte-identically inside one turn. Without this
    // the harness's dedup ledger short-circuits only prior SUCCESSES, so a rejected write
    // re-runs the identical rejected call up to the error-streak cap — the observed build
    // loop, now closed on the chat path too. This is the harness's failed-call guard and is
    // separate from the confirmation gate above (`callTool`), which is what makes a write wait
    // for the user.
    writeToolNames: [...WRITE_TOOL_NAMES],
  });
  return {
    ...result,
    tab: input.tab,
    artifacts,
    traceId,
    conversationId,
    pendingCards: askPendingCards(input.user.id, result.pending, toolDescription),
  };
}
