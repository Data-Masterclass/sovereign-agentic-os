/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { stripThinking } from '@/lib/agent-chat-response';

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

function actSystem(system: string, plan: string, tools: ToolSpec[], react: boolean): string {
  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return [
    system,
    '',
    'You now EXECUTE this plan by calling the available tools. Do real work — do not',
    'just describe it. Call one tool at a time; use each result to decide the next',
    'step. When the goal is met, stop and give a concise final summary of what you',
    'did (files committed, preview URL, deploy-review status).',
    '',
    'Your plan:',
    plan,
    '',
    'Available tools:',
    toolList,
    react ? REACT_INSTRUCTIONS : '',
  ].join('\n');
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
}): Promise<AgenticResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const user = opts.userMessages.map((m) => ({ role: m.role, content: m.content }));

  // (a) PLAN — reasoning tier, no tools.
  const planCompletion = await opts.llm({
    model: opts.planModel,
    messages: [{ role: 'system', content: planPrompt(opts.system) }, ...user],
    temperature: 0.2,
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
        messages,
        tools: react ? undefined : wire,
        temperature: 0.2,
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
      steps.push({ tool: call.name, args: call.args, result: out.text, isError: out.isError });
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
