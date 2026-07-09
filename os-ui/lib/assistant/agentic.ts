/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { stripThinking } from '@/lib/agent-chat-response';
import {
  estimateTokens,
  compactToolResult,
  truncateToTokens,
} from '@/lib/infra/context/context-assembler';

/**
 * THE AGENTIC ASSISTANT HARNESS (pure core).
 *
 * The shared loop every OS tab assistant runs so it ACTS instead of only
 * chatting: PLAN once with the reasoning tier, then ACT in a bounded tool-calling
 * loop with the light/execution tier — the model calls the tab's MCP tools, we
 * execute them through the SAME governed function the MCP route uses (OPA + role
 * gate + Langfuse, never bypassed), feed the results back, and stop on a final
 * answer or the iteration cap.
 *
 * This module is TRANSPORT-FREE and side-effect-free: the LiteLLM call (`llm`)
 * and the governed tool executor (`callTool`) are INJECTED, so the loop is
 * trivially unit-testable and carries no `fetch`/`server-only` coupling. The
 * server wiring that binds it to LiteLLM + the per-tab MCP registry lives in
 * `lib/assistant/runtime.ts`.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export type LlmMessage = {
  role: ChatRole;
  content: string;
  /** OpenAI native tool-call request echoed back on the assistant turn. */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /** Links a `role:'tool'` result to the assistant tool_call that requested it. */
  tool_call_id?: string;
};

/** A JSON-schema-ish object (the per-tab MCP `inputSchema`). */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};

export type OpenAiTool = {
  type: 'function';
  function: { name: string; description: string; parameters: ToolSpec['inputSchema'] };
};

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type LlmCompletion = { content: string; toolCalls: ToolCall[] };

export type LlmRequest = {
  model: string;
  messages: LlmMessage[];
  tools?: OpenAiTool[];
  temperature?: number;
  /** Cap on the model's OWN output (the model window's reserved tail). */
  maxTokens?: number;
};
export type LlmCall = (req: LlmRequest) => Promise<LlmCompletion>;

/** Execute one governed tool call; returns the model-readable result text. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

export type AgenticStep = { tool: string; args: Record<string, unknown>; result: string; isError: boolean };

export type AgenticResult = {
  plan: string;
  steps: AgenticStep[];
  finalText: string;
  iterations: number;
  /** false once we fell back to the ReAct JSON protocol (model lacks tool-calling). */
  toolCallingSupported: boolean;
};

/** Thrown by an `llm` caller when the model/gateway rejects the `tools` param. */
export class ToolCallingUnsupportedError extends Error {
  constructor(message = 'The model does not support tool/function calling') {
    super(message);
    this.name = 'ToolCallingUnsupportedError';
  }
}

const DEFAULT_MAX_ITERATIONS = 6;

export function toOpenAiTools(tools: ToolSpec[]): OpenAiTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/**
 * Parse a single ReAct-style action out of plain model text (the fallback when a
 * model has no native function-calling). Accepts a fenced ```json block or a bare
 * JSON object; returns the first `{ "tool", "args" }` action found, or null when
 * the text is a final answer (no tool, or an explicit `{ "final": ... }`).
 */
export function parseReactAction(text: string): { tool: string; args: Record<string, unknown> } | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  // Bare object: from the first "{" to its matching "}" (non-greedy best-effort).
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (obj && typeof obj.tool === 'string') {
        return { tool: obj.tool, args: (obj.args as Record<string, unknown>) ?? {} };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const REACT_INSTRUCTIONS = [
  '',
  'TOOL PROTOCOL (this model has no native function-calling): to call a tool, reply',
  'with ONLY a single JSON object on its own line: {"tool":"<name>","args":{...}}.',
  'You will then receive an "Observation:" with the result and may call another',
  'tool. When you are done, reply with your final answer as plain prose (no JSON).',
].join('\n');

function planPrompt(system: string): string {
  return [
    system,
    '',
    'First, think step by step and produce a SHORT numbered plan (3-6 steps) for how',
    'you will fulfil the request using the available tools. Output only the plan.',
  ].join('\n');
}

/**
 * DISCOVER-THEN-ACT directive (#97): agents were GUESSING table FQNs and querying
 * non-existent tables. This tells the model to LEARN the exact resource via the
 * read-only discovery tools before acting. Included only when a relevant action or
 * discovery tool is actually available, so it never clutters an unrelated agent.
 */
function discoveryDirective(tools: ToolSpec[]): string {
  const names = new Set(tools.map((t) => t.name));
  const has = (...t: string[]) => t.some((n) => names.has(n));
  const lines: string[] = [];
  if (has('query_data', 'list_datasets', 'get_dataset', 'profile_dataset')) {
    lines.push(
      '- DATA: before query_data, call list_datasets then get_dataset to obtain the',
      '  EXACT fully-qualified table name (iceberg.<schema>.<table>) — never guess a',
      '  schema or table name. Use profile_dataset to learn the columns before querying.',
      '  Any table name in your role/instructions is a HINT that may be STALE — a dataset',
      "  promoted since then lives at iceberg.<domain>.gold_<slug>, NOT the owner's",
      '  personal_<uid> lane. The FQN get_dataset/profile_dataset return for YOU is the',
      '  only authoritative one; re-resolve it every run and query exactly that, never a',
      '  remembered personal_* path.',
    );
  }
  if (has('search_knowledge', 'list_knowledge')) {
    lines.push('- KNOWLEDGE: use list_knowledge to see what exists, then search_knowledge to retrieve it.');
  }
  if (has('search_files', 'list_files', 'get_file', 'read_app_files')) {
    lines.push('- FILES: use list_files / search_files to find the exact file before reading it.');
  }
  if (lines.length === 0) return '';
  return ['', 'DISCOVER BEFORE YOU ACT — never guess identifiers:', ...lines].join('\n');
}

function actSystem(system: string, plan: string, tools: ToolSpec[], react: boolean): string {
  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return [
    system,
    '',
    'You now EXECUTE this plan by calling the available tools. Do real work — do not',
    'just describe it. Call one tool at a time; use each result to decide the next',
    'step. When the goal is met, stop and give a concise final summary of what you',
    'did (files committed, preview URL, deploy-review status).',
    discoveryDirective(tools),
    '',
    'Your plan:',
    plan,
    '',
    'Available tools:',
    toolList,
    react ? REACT_INSTRUCTIONS : '',
  ].join('\n');
}

const DEFAULT_MESSAGE_BUDGET = 24_000;

function messagesTokens(messages: LlmMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content ?? ''), 0);
}

/**
 * Bound an ACT-loop `messages[]` to `budget` tokens — the fix for the LiteLLM 400
 * ContextWindowExceededError. The loop appended full, uncapped tool results, and
 * (in the multi-node graph) inherited the whole transcript, compounding past the
 * model window. This caps every model call at a hard input ceiling.
 *
 * PROTOCOL-SAFE: the leading `system` + `user` turns are PINNED (the task spine),
 * and the conversation tail is bounded WITHOUT breaking the OpenAI tool-call
 * contract — a `role:'tool'` result must stay paired with the `assistant` turn
 * that requested it. So we (1) COMPACT every oversized tool/assistant body in
 * place (row-set → header+first-N; long text → head+tail), then (2) if still over,
 * drop OLDEST turns first while always keeping the pinned head and the most recent
 * turn. As a last resort the pinned head itself is truncated so the ceiling holds.
 */
export function budgetMessages(messages: LlmMessage[], budget: number): LlmMessage[] {
  if (messagesTokens(messages) <= budget) return messages;

  // Pinned head: the leading system message(s) + the initial user turn(s), before
  // the first assistant/tool turn. These are the task spine and are never dropped.
  let head = 0;
  while (head < messages.length && (messages[head].role === 'system' || messages[head].role === 'user')) {
    head += 1;
  }
  const pinned = messages.slice(0, head);
  const tail = messages.slice(head);

  // (1) Compact oversized tool/assistant bodies in place.
  const compacted = tail.map((m) =>
    (m.role === 'tool' || m.role === 'assistant') && m.content
      ? { ...m, content: compactToolResult(m.content) }
      : m,
  );

  // (2) Drop oldest tail turns until it fits, but keep at least the last message.
  const pinnedTokens = messagesTokens(pinned);
  let start = 0;
  while (
    start < compacted.length - 1 &&
    pinnedTokens + messagesTokens(compacted.slice(start)) > budget
  ) {
    // Advance past a whole turn: an assistant(tool_calls) + its trailing tool msgs.
    start += 1;
    while (start < compacted.length - 1 && compacted[start].role === 'tool') start += 1;
  }
  const keptTail = compacted.slice(start);

  // (2b) If the pinned head fits but head + kept tail still overflows (a single
  // large last turn that compaction couldn't shrink enough), truncate the last
  // kept message to close the remaining gap — the ceiling is non-negotiable.
  if (pinnedTokens <= budget && keptTail.length > 0) {
    const overflow = pinnedTokens + messagesTokens(keptTail) - budget;
    if (overflow > 0) {
      const lastIdx = keptTail.length - 1;
      const last = keptTail[lastIdx];
      const allowed = Math.max(0, estimateTokens(last.content) - overflow);
      keptTail[lastIdx] = { ...last, content: truncateToTokens(last.content, allowed) };
    }
  }

  // (3) Last resort: pinned head alone still over budget → truncate it to fit.
  if (pinnedTokens > budget) {
    const shrunk: LlmMessage[] = [];
    let used = 0;
    for (const m of pinned) {
      const remaining = budget - used;
      if (remaining <= 0) break;
      const text = estimateTokens(m.content) > remaining ? truncateToTokens(m.content, remaining) : m.content;
      shrunk.push({ ...m, content: text });
      used += estimateTokens(text);
    }
    return shrunk;
  }

  return [...pinned, ...keptTail];
}

/**
 * Run the PLAN → ACT loop. Returns the plan, every governed tool call made, and
 * the final answer. Guarantees: planning uses `planModel` with NO tools; acting
 * uses `actModel`; tool calls are executed only via the injected governed
 * `callTool`; the loop is bounded by `maxIterations`; and if the model rejects
 * the `tools` param we transparently fall back to a ReAct JSON protocol.
 */
export async function runAgentic(opts: {
  system: string;
  userMessages: { role: 'user' | 'assistant'; content: string }[];
  tools: ToolSpec[];
  callTool: ToolExecutor;
  llm: LlmCall;
  planModel: string;
  actModel: string;
  maxIterations?: number;
  /**
   * Input token budget for EVERY model call — the hard ceiling the assembled
   * messages are bounded to (fixes the LiteLLM 400 ContextWindowExceededError).
   * The server wiring passes the model window minus reserved output; unset uses a
   * safe default.
   */
  budget?: number;
  /** Cap on the model's own output per call (the reserved-output tail). */
  maxOutputTokens?: number;
  /** Optional progress hook — called after each governed tool step executes. */
  onStep?: (step: AgenticStep) => void;
}): Promise<AgenticResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const budget = opts.budget ?? DEFAULT_MESSAGE_BUDGET;
  const user = opts.userMessages.map((m) => ({ role: m.role, content: m.content }));

  // (a) PLAN — reasoning tier, no tools. Budget the plan prompt too.
  const planCompletion = await opts.llm({
    model: opts.planModel,
    messages: budgetMessages([{ role: 'system', content: planPrompt(opts.system) }, ...user], budget),
    temperature: 0.2,
    maxTokens: opts.maxOutputTokens,
  });
  const plan = stripThinking(planCompletion.content) || '(no plan produced)';

  // (b) ACT — execution tier, bounded tool-calling loop.
  const steps: AgenticStep[] = [];
  const wire = toOpenAiTools(opts.tools);
  let react = false; // flips to true if the model rejects native tool-calling
  let messages: LlmMessage[] = [
    { role: 'system', content: actSystem(opts.system, plan, opts.tools, react) },
    ...user,
  ];

  let iterations = 0;
  let finalText = '';
  while (iterations < maxIterations) {
    let completion: LlmCompletion;
    try {
      completion = await opts.llm({
        model: opts.actModel,
        messages: budgetMessages(messages, budget),
        tools: react ? undefined : wire,
        temperature: 0.2,
        maxTokens: opts.maxOutputTokens,
      });
    } catch (e) {
      // Native tool-calling unsupported → rebuild the system prompt with the ReAct
      // protocol and retry this same iteration WITHOUT the tools param. Any other
      // error propagates to the caller (the route surfaces it cleanly).
      if (!react && e instanceof ToolCallingUnsupportedError) {
        react = true;
        messages = [
          { role: 'system', content: actSystem(opts.system, plan, opts.tools, react) },
          ...user,
        ];
        continue;
      }
      throw e;
    }

    // Resolve the requested tool calls: native structured calls, else a ReAct
    // action parsed from the text. No calls → this completion is the final answer.
    const calls: ToolCall[] =
      !react && completion.toolCalls.length > 0
        ? completion.toolCalls
        : reactCall(completion.content);

    if (calls.length === 0) {
      finalText = stripThinking(completion.content);
      break;
    }

    iterations += 1;

    // Record the assistant turn so the model sees its own request in context.
    if (react) {
      messages.push({ role: 'assistant', content: completion.content });
    } else {
      messages.push({
        role: 'assistant',
        content: completion.content,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
    }

    // Execute each call through the governed executor and feed the result back.
    for (const call of calls) {
      const out = await opts.callTool(call.name, call.args);
      const step: AgenticStep = { tool: call.name, args: call.args, result: out.text, isError: out.isError };
      steps.push(step);
      opts.onStep?.(step);
      if (react) {
        messages.push({ role: 'user', content: `Observation: ${out.text}` });
      } else {
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
      }
    }
  }

  if (!finalText) {
    finalText =
      iterations >= maxIterations
        ? 'Reached the tool step limit (cap) before finishing — review the steps above and continue if needed.'
        : '(no final answer produced)';
  }

  return { plan, steps, finalText, iterations, toolCallingSupported: !react };
}

/** ReAct-mode call resolution: one action per turn, or none (final answer). */
function reactCall(content: string): ToolCall[] {
  const action = parseReactAction(content);
  return action ? [{ id: `react-${action.tool}`, name: action.tool, args: action.args }] : [];
}
