/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import type { CurrentUser } from '@/lib/auth';
import { handleRpc, toolsForTab, listToolsForRole, type McpTab } from '@/lib/mcp/server';
import { loadTabContext, tabTitle } from '@/lib/tabs/context';
import {
  runAgentic,
  ToolCallingUnsupportedError,
  type AgenticResult,
  type LlmCall,
  type LlmCompletion,
  type ToolExecutor,
  type ToolSpec,
} from './agentic.ts';
import { resolveAssistantModelId } from './complete.ts';

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

const LLM_TIMEOUT_MS = Number(process.env.LLM_CHAT_TIMEOUT_MS ?? '') || 90_000;

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
    return parseLlmMessage(message);
  };
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
  return runAgentic({
    system: osSystem(input.tab, input.extraContext),
    userMessages: input.messages,
    tools: tabToolSpecs(input.user, input.tab),
    callTool: tabToolExecutor(input.user, input.tab),
    llm: injected ?? liteLlmCaller(),
    planModel: injected ? config.litellmReasoningModel : assistantId,
    actModel: assistantId,
    maxIterations: input.maxIterations,
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
