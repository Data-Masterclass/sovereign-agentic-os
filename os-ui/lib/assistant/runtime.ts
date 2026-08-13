/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import type { CurrentUser } from '@/lib/core/auth';
import { handleRpc, toolsForTab, listToolsForRole, type McpTab } from '@/lib/mcp/server';
import { loadTabContext, tabTitle } from '@/lib/tabs/context';
import {
  runAgentic,
  ToolCallingUnsupportedError,
  type AgenticResult,
  type AgenticStep,
  type LlmCall,
  type LlmCompletion,
  type LlmUsage,
  type ToolExecutor,
  type ToolSpec,
} from './agentic.ts';
import { resolveAssistantModelId } from './complete.ts';
import { inputBudget, modelContext } from '@/lib/models/context-windows';

/**
 * Server wiring for the agentic assistant harness. Binds the pure PLAN→ACT loop
 * (`agentic.ts`) to:
 *   • the OS-wide rules preamble + the tab's CONTEXT.md as the system prompt;
 *   • the tab's role-scoped MCP tool schemas (the SAME per-tab registry the
 *     `/api/mcp/<tab>` endpoint serves);
 *   • a governed executor that runs each tool through `handleRpc` — the EXACT
 *     dispatch the MCP route uses, so OPA + the role floor + Langfuse audit apply
 *     unchanged (no privileged path);
 *   • the two-tier LiteLLM models (reasoning to plan, light to act).
 *
 * Both the Software build chat and the in-app helper assistants call this, each
 * scoped to their own tab — so every tab assistant ACTS, it does not only chat.
 */

// OS-wide rules every tab assistant is grounded in (short, before the tab context).
const OS_RULES = [
  'You are a build assistant inside the Sovereign Agentic OS — a governed, sovereign',
  'platform where nothing leaves the tenant boundary. Operate under these rules:',
  '- Sovereign boundary: all models + tools are in-tenant and governed; never assume',
  '  an external service. Consume granted resources by reference, never a raw secret.',
  '- Governance & roles: every tool call runs under the user\'s delegated identity and',
  '  is OPA-authorized, role-gated and Langfuse-audited. Some tools need Builder+;',
  '  if one is denied, explain it plainly instead of retrying blindly.',
  '- Deploy is a Builder-REVIEWED DRAFT, never auto-live: request_deploy opens a review',
  '  gate; it does not go live until a Builder approves. Do the buildable work, then',
  '  leave the go-live for review.',
  '- Prefer real action over description: use your tools to actually do the task.',
].join('\n');

function osSystem(tab: McpTab, extraContext?: string): string {
  const parts = [
    OS_RULES,
    '',
    `--- ${tabTitle(tab)} TAB CONTEXT (authoritative environment reference) ---`,
    loadTabContext(tab) || '(no tab context available)',
  ];
  if (extraContext && extraContext.trim()) {
    parts.push('', '--- ADDITIONAL CONTEXT ---', extraContext.trim());
  }
  return parts.join('\n');
}

/** The role-scoped tool schemas for a tab, shaped for the harness. */
export function tabToolSpecs(user: CurrentUser, tab: McpTab): ToolSpec[] {
  return listToolsForRole(user.role, toolsForTab(tab)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as ToolSpec['inputSchema'],
  }));
}

/**
 * A governed tool executor: dispatch through the SAME `handleRpc` the MCP route
 * uses, scoped to the tab's tool subset. The role floor is re-checked there and
 * the underlying governed function (OPA + Langfuse) is the real authority, so
 * this never bypasses governance.
 */
export function tabToolExecutor(user: CurrentUser, tab: McpTab): ToolExecutor {
  const tools = toolsForTab(tab);
  return async (name, args) => {
    const res = await handleRpc(
      user,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { tools },
    );
    // A JSON-RPC error means the role floor rejected the tool (or it doesn't
    // exist) — surface it to the model as a clean, actionable tool error.
    if (res?.error) return { text: `Error: ${res.error.message}`, isError: true };
    const result = (res?.result ?? {}) as { content?: { text?: string }[]; isError?: boolean };
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? '';
    return { text: text || '(no output)', isError: !!result.isError };
  };
}

/**
 * Merge the run's server-KNOWN args into one model-issued tool call. The run is
 * inherently scoped (e.g. a per-app Build chat is bound to ONE `appId`), so the
 * model should never have to repeat — or be trusted to supply — an id the server
 * already holds. For each bound key:
 *   • omitted / empty by the model  → filled in from the bound value (the fix for
 *     `commit({})` → not_found: an empty-args call now carries the real appId);
 *   • supplied and EQUAL             → accepted (idempotent);
 *   • supplied and DIFFERENT         → REJECTED, so a model cannot redirect a write
 *     at another scope. Returns `{ error }` the caller surfaces as a tool error.
 * Bound values always win, but a conflict is loud rather than silently overwritten.
 */
export function bindToolArgs(
  args: Record<string, unknown>,
  bound: Record<string, unknown>,
): { args: Record<string, unknown>; error?: string } {
  const merged: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(bound)) {
    const supplied = merged[key];
    const missing = supplied === undefined || supplied === null || supplied === '';
    if (!missing && supplied !== value) {
      return {
        args: merged,
        error:
          `this run is scoped to ${key} ${String(value)} — you passed ${key} ` +
          `${JSON.stringify(supplied)}, which does not match. Drop the ${key} argument ` +
          `(it is bound automatically) and retry.`,
      };
    }
    merged[key] = value;
  }
  return { args: merged };
}

/**
 * Wrap a governed `ToolExecutor` so the run's server-known args (see {@link bindToolArgs})
 * are merged into EVERY call before dispatch, and a conflicting model-supplied value is
 * rejected as a clean tool error WITHOUT ever reaching the underlying governed function.
 */
export function boundExecutor(base: ToolExecutor, bound: Record<string, unknown>): ToolExecutor {
  return async (name, args) => {
    const b = bindToolArgs(args, bound);
    if (b.error) return { text: `Error: ${b.error}`, isError: true };
    return base(name, b.args);
  };
}

// 240s default: Build runs on the REASONING model (0.6.107), which can take well over the
// old 90s to generate a full multi-file commit in one act — a shorter cap aborted the fetch
// mid-generation and surfaced as "the model did not respond in time" with nothing streamed.
const LLM_TIMEOUT_MS = Number(process.env.LLM_CHAT_TIMEOUT_MS ?? '') || 240_000;

/**
 * A LiteLLM-backed `LlmCall`. Sends OpenAI-shaped chat completions through the
 * governed gateway. When a request carries `tools` and the model/gateway rejects
 * function-calling (HTTP 400 mentioning tools/functions), throws
 * `ToolCallingUnsupportedError` so the loop falls back to the ReAct protocol.
 */
export function liteLlmCaller(): LlmCall {
  return async (req) => {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
    };
    // Cap the model's own output at the model window's reserved tail — the other
    // half of the context-budget guarantee (input is bounded by the assembler).
    if (req.maxTokens && req.maxTokens > 0) body.max_tokens = req.maxTokens;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${config.litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.litellmMasterKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: ctrl.signal,
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // A tools-related 400 means this model has no function-calling → fall back.
      if (req.tools && res.status === 400 && /tool|function/i.test(text)) {
        throw new ToolCallingUnsupportedError(`LiteLLM 400 rejecting tools: ${text.slice(0, 200)}`);
      }
      throw new Error(`LiteLLM ${res.status}: ${text.slice(0, 300)}`);
    }

    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`LiteLLM returned non-JSON: ${text.slice(0, 200)}`);
    }
    const choices = (data.choices ?? []) as Array<Record<string, unknown>>;
    const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
    const completion = parseLlmMessage(message);
    // Surface the gateway's reported token usage so a run path can aggregate it
    // (the Monitoring run-summary trace). Absent/malformed usage stays undefined.
    const usage = parseLlmUsage(data.usage);
    return usage ? { ...completion, usage } : completion;
  };
}

/**
 * Parse a chat-completions `usage` block ({prompt_tokens, completion_tokens,
 * total_tokens}) into the harness shape — only when the gateway actually reported
 * numbers. Anything absent or malformed → undefined (usage is never fabricated).
 */
export function parseLlmUsage(raw: unknown): LlmUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined;
  const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const total = typeof u.total_tokens === 'number' ? u.total_tokens : (input ?? 0) + (output ?? 0);
  return { input: input ?? 0, output: output ?? 0, total };
}

/**
 * Strip OpenAI "harmony" channel control tokens (gpt-oss / gpt-oss-20b) out of a
 * string. Harmony framing (`<|start|>…<|channel|>commentary<|message|>…<|end|>`,
 * plus `<|call|>`/`<|return|>`) can leak into a tool-call's `function.name` (e.g.
 * `query_data<|channel|>commentary`) or wrap a tool call emitted as commentary
 * TEXT rather than as a structured `tool_calls` entry. We defensively strip every
 * such control token so a harmony-formatting model degrades gracefully instead of
 * erroring with a mangled tool name.
 */
const HARMONY_TOKEN = /<\|[^|]*\|>/g;

export function stripHarmonyTokens(s: string): string {
  return s.replace(HARMONY_TOKEN, '').trim();
}

/** Clean a leaked tool name: drop harmony tokens and any channel-word tail. */
function cleanToolName(raw: string): string {
  // `query_data<|channel|>commentary` → strip tokens → `query_datacommentary`?
  // No: strip the token AND everything the model appended after it (channel word,
  // `to=…` routing, whitespace). A valid MCP tool name is a bare identifier.
  const beforeToken = raw.split('<|')[0];
  const cleaned = stripHarmonyTokens(beforeToken);
  const m = cleaned.match(/[A-Za-z_][A-Za-z0-9_]*/);
  return m ? m[0] : cleaned;
}

function safeArgs(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

/**
 * Recover a tool call a harmony model emitted as commentary-channel TEXT instead
 * of a structured `tool_calls` entry — e.g. `…<|channel|>commentary to=query_data
 * <|message|>{"question":"…"}<|call|>`. Returns the first `{ name, args }` found,
 * or null. Best-effort and side-effect-free; the native `tool_calls` path is
 * always preferred when present.
 */
export function parseHarmonyToolCall(content: string): { name: string; args: Record<string, unknown> } | null {
  if (!content.includes('<|')) return null;
  // `to=<name>` names the tool the commentary channel is calling.
  const to = content.match(/to=\s*([A-Za-z_][A-Za-z0-9_.]*)/);
  if (!to) return null;
  const name = cleanToolName(to[1]);
  if (!name) return null;
  // Args are the JSON object after the last `<|message|>` (or the first `{…}`).
  const afterMsg = content.split('<|message|>').pop() ?? content;
  const brace = afterMsg.match(/\{[\s\S]*\}/);
  return { name, args: brace ? safeArgs(brace[0]) : {} };
}

/** Parse an OpenAI-shaped assistant message into the harness completion shape. */
export function parseLlmMessage(message: Record<string, unknown>): LlmCompletion {
  const rawContent = String(message.content ?? '');
  const content = stripHarmonyTokens(rawContent);
  const rawCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
  const toolCalls = rawCalls
    .map((c, i) => {
      const fn = (c.function ?? {}) as Record<string, unknown>;
      const name = cleanToolName(String(fn.name ?? ''));
      if (!name) return null;
      return { id: String(c.id ?? `call-${i}`), name, args: safeArgs(fn.arguments) };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // Fallback: a harmony model that emitted its tool call as commentary TEXT (no
  // structured tool_calls) still gets executed instead of treated as a final answer.
  if (toolCalls.length === 0) {
    const recovered = parseHarmonyToolCall(rawContent);
    if (recovered) toolCalls.push({ id: 'harmony-0', name: recovered.name, args: recovered.args });
  }

  return { content, toolCalls };
}

export type RunTabAgentInput = {
  user: CurrentUser;
  tab: McpTab;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** App/product-specific context appended below the tab CONTEXT.md. */
  extraContext?: string;
  maxIterations?: number;
  /**
   * Optional ALLOWLIST of tool names. When given, the model is only shown these
   * tools AND the executor hard-rejects any other call — a real guarantee (not a
   * prompt hint) used by the Software Build stage's Plan mode to run read-only
   * (no `commit` / `request_deploy` / `start_preview` write path).
   */
  toolNames?: string[];
  /**
   * Server-KNOWN arguments the run is inherently scoped to (e.g. `{ appId }` for the
   * per-app Build chat). Bound here so the model never has to repeat an id the server
   * already knows — every tool call gets these merged in (see {@link bindToolArgs}). A
   * model-supplied value that MATCHES is accepted; one that CONFLICTS is rejected loudly
   * (no cross-scope write); an omitted one is filled in (fixes `commit({})` → not_found).
   */
  boundArgs?: Record<string, unknown>;
  /**
   * Progress hook — called once per governed tool step as it executes (the SAME
   * `AgenticStep` the result later carries). The Software Build stage plumbs this
   * to a streaming response so each tool-call surfaces as a live activity line
   * instead of a silent spinner. Pure UI wiring; it never changes what runs.
   */
  onStep?: (step: AgenticStep) => void;
  /** Progress hook — called once with the plan text as soon as PLAN completes. */
  onPlan?: (plan: string) => void;
  /**
   * Optional MODEL override (a LiteLLM model_name, e.g. `roleModel('reasoning')`).
   * When set, BOTH plan and act run on it — the Software Build passes the reasoning
   * tier here so code GENERATION runs on the strong model, not the platform
   * assistant/standard default. Unset ⇒ the platform assistant model (unchanged for
   * every other tab assistant).
   */
  model?: string;
  /**
   * BOUNDED reasoning escalation (opt-in). A LiteLLM model_name (e.g.
   * `roleModel('reasoning')`) the ACT loop switches to ONCE if a tool keeps failing on
   * a shape error. The Software Build stage passes it so a STANDARD-tier build that
   * cannot complete its `commit` gets exactly one reasoning-tier retry — labelled, not
   * silent. Unset = no escalation (the default for every other assistant).
   */
  escalateActModel?: string;
  /** Called once when escalation fires — the build route renders it as a labelled activity line. */
  onEscalate?: (info: { tool: string; from: string; to: string; failures: number }) => void;
  /**
   * WRITE tools whose FAILED calls must never re-run byte-identically (the build-loop guard).
   * The Software Build passes `['commit']` so a compile-gate rejection is never re-committed
   * unchanged. Unset ⇒ no guard (every other assistant is unchanged).
   */
  writeToolNames?: string[];
  /** Injected in tests; defaults to the live LiteLLM caller. */
  llm?: LlmCall;
};

/** Run one PLAN→ACT turn for a tab assistant and return the full trace. */
export async function runTabAgent(input: RunTabAgentInput): Promise<AgenticResult> {
  // Production callers run on the ONE platform-admin assistant model (the same
  // model every built-in assistant uses); if none is configured this throws an
  // honest, admin-actionable error rather than silently answering with fake AI.
  // An INJECTED `llm` (tests/advanced) owns model selection, so we leave the
  // config tiers as opaque ids the fake caller ignores.
  const injected = input.llm;
  const assistantId = injected ? config.litellmExecModel : resolveAssistantModelId();
  // The model this run ACTUALLY executes on: an explicit override (the Software Build
  // passes the reasoning tier) wins over the platform assistant default. Tests inject
  // their own caller, so they keep the opaque exec id. The context window + budget +
  // output cap all follow the model that runs, not a stale default.
  const runModel = injected ? assistantId : (input.model ?? assistantId);
  const ctx = modelContext(runModel);
  const allow = input.toolNames ? new Set(input.toolNames) : null;
  const specs = allow
    ? tabToolSpecs(input.user, input.tab).filter((t) => allow.has(t.name))
    : tabToolSpecs(input.user, input.tab);
  const baseExec = tabToolExecutor(input.user, input.tab);
  // Bind the run's server-known args (e.g. appId) into EVERY tool call BEFORE the
  // allowlist/governed dispatch — a run scoped to one app never depends on the model
  // repeating its id, and a mismatched id is rejected loudly (never a cross-app write).
  const withBinding = input.boundArgs ? boundExecutor(baseExec, input.boundArgs) : baseExec;
  const callTool = allow
    ? async (name: string, args: Record<string, unknown>) =>
        allow.has(name)
          ? withBinding(name, args)
          : { text: `Error: tool "${name}" is not available in this mode.`, isError: true }
    : withBinding;
  return runAgentic({
    system: osSystem(input.tab, input.extraContext),
    userMessages: input.messages,
    tools: specs,
    callTool,
    llm: injected ?? liteLlmCaller(),
    planModel: injected ? config.litellmReasoningModel : runModel,
    actModel: runModel,
    maxIterations: input.maxIterations,
    budget: inputBudget(runModel),
    maxOutputTokens: ctx.reservedOutput,
    onStep: input.onStep,
    onPlan: input.onPlan,
    escalateActModel: input.escalateActModel,
    onEscalate: input.onEscalate,
    writeToolNames: input.writeToolNames,
  });
}

/**
 * Render an AgenticResult as the assistant chat text (the existing UI reads
 * `{ content }`, so the whole plan→act→deploy trace flows through unchanged).
 */
export function renderAssistantText(result: AgenticResult): string {
  const lines: string[] = ['### Plan', result.plan, ''];
  if (result.steps.length > 0) {
    lines.push('### Actions');
    for (const s of result.steps) {
      const mark = s.isError ? '⚠︎' : '✓';
      const preview = s.result.length > 400 ? `${s.result.slice(0, 400)}…` : s.result;
      lines.push(`${mark} \`${s.tool}\` — ${preview}`);
    }
    lines.push('');
  }
  lines.push('### Result', result.finalText);
  if (!result.toolCallingSupported) {
    lines.push('', '_(ran via the ReAct tool protocol — this model has no native function-calling.)_');
  }
  return lines.join('\n');
}
