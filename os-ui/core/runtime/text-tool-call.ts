/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents (shared runtime helper)
 * FEATURE:    Recognise a reply that IS a tool call written as text (not made through the tools interface), so an
 *             agent run never PRESENTS such a call as its answer.
 * USER STORY: As the owner I never see `<tool_call>{"name": …}</tool_call>` as my agent's final answer
 *             (dev, 23 Nov 2026: the strong model wrote its call into the reply's text and the engine
 *             showed that text as the result).
 * ARCHITECTURE:
 *   - WHAT THIS IS ABOUT: a reply the run could not execute as a call must not become the answer. This module only
 *     DETECTS; it parses nothing to run. The caller (the agent engine, the module engine's middleware, the cap
 *     synthesis) asks the model once more with {@link TEXT_TOOL_CALL_PROMPT} and fails the step with
 *     {@link TextToolCallError} if it happens again.
 *   - WHAT IT IS NOT: two existing recoveries DO parse a textual call and run it — the ReAct-shaped `{"tool": …,
 *     "args": …}` reply (`reactCall`, the native-mode fallback in the engine) and a gpt-oss harmony call
 *     (`parseHarmonyToolCall` in `parseLlmMessage`). Those run ONLY if the node is offered that tool (anything else,
 *     the lead tools included, is the engine's typed `not_found`) and they go through the governed executor (OPA,
 *     grant scope, holds) like any call. The gateway's `allowed_tools` check does NOT see them: it only sees the
 *     `tool_calls` field, and these calls arrived as text.
 *   - STRICT, to avoid false alarms: code (``` fences and `inline`) is ignored; a markup block counts only when the
 *     reply starts with it or it is most of the reply; a bare JSON call counts only when the whole reply is that
 *     call and its name is a tool the caller knows. Shapes (each family's documented chat-template markup):
 *       · Qwen / Hermes template (Qwen2.5, Qwen3, Qwen3-VL; the XML `<function=…>` body too): `<tool_call>…</tool_call>`;
 *       · Kimi K2: `<|tool_calls_section_begin|><|tool_call_begin|>functions.name:0<|tool_call_argument_begin|>{…}`;
 *       · DeepSeek V3 / V3.1 / R1: `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>…<｜tool▁sep｜>…` (full-width bars);
 *       · gpt-oss (harmony): `<|channel|>commentary to=functions.name … <|message|>{…}<|call|>`;
 *       · `<|tool_call|>[…]` (Phi-4-mini, Granite) and Mistral's `[TOOL_CALLS][…]`;
 *       · a reply that is nothing but an OpenAI-style call object naming a known tool.
 *   - Read the RAW model text where possible: `parseLlmMessage` strips `<|…|>` control tokens from `content`, so it
 *     records the detection on the completion (`textToolCall`) before stripping.
 */

/** A markup block: where it opens, and how it closes (absent close = to the end of the reply). */
const BLOCKS: { format: string; open: RegExp; close?: RegExp; needsBody?: boolean }[] = [
  { format: 'qwen/hermes <tool_call>', open: /<tool_call>/i, close: /<\/tool_call>/i },
  { format: 'kimi <|tool_call_begin|>', open: /<\|tool_calls_section_begin\|>|<\|tool_call_begin\|>/, close: /<\|tool_calls_section_end\|>|<\|tool_call_end\|>/ },
  { format: 'deepseek <｜tool▁call▁begin｜>', open: /<[|｜]tool[▁_]calls?[▁_]begin[|｜]>/, close: /<[|｜]tool[▁_]calls?[▁_]end[|｜]>/ },
  { format: 'harmony to=functions.…', open: /(?:<\|start\|>assistant)?<\|channel\|>\s*commentary\s+to=[\w.]+[^<]*(?:<\|constrain\|>\w*)?\s*<\|message\|>/, close: /<\|call\|>/ },
  { format: '<|tool_call|>', open: /<\|tool_call\|>\s*(?=[[{])/, needsBody: true },
  { format: 'mistral [TOOL_CALLS]', open: /\[TOOL_CALLS\]\s*(?=[[{])/, needsBody: true },
];

/** The reply with code (``` fences, `inline`) removed: markup inside code is documentation, not a call. */
function outsideCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One OpenAI-/Llama-style function-call object naming a tool in `names`. */
function isCallObject(v: unknown, names: ReadonlySet<string>): boolean {
  if (!isRecord(v)) return false;
  if (Array.isArray(v.tool_calls) && v.tool_calls.length > 0) return v.tool_calls.every((c) => isCallObject(c, names));
  if (isRecord(v.function_call)) return isCallObject(v.function_call, names);
  if (v.type === 'function' && isRecord(v.function)) return isCallObject(v.function, names);
  if (typeof v.name !== 'string' || !names.has(v.name)) return false;
  const args = v.arguments ?? v.parameters;
  if (!(isRecord(args) || typeof args === 'string')) return false;
  return Object.keys(v).every((k) => ['name', 'arguments', 'parameters', 'id', 'type'].includes(k));
}

/** The whole reply (one optional ``` fence aside) is a call object, or a list of them, naming known tools. */
function wholeReplyIsCallJson(text: string, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  let body = text.trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) body = fenced[1].trim();
  if (!(body.startsWith('{') || body.startsWith('['))) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed.length > 0 && parsed.every((c) => isCallObject(c, names)) : isCallObject(parsed, names);
  } catch {
    return false;
  }
}

/**
 * The tool-call format when the reply IS a tool call written as text, else null. `toolNames` are the tools the caller
 * knows (offered ones and the lead tools): only they make a bare JSON object a call. Detection only — nothing is run.
 */
export function detectTextToolCall(content: string, toolNames: Iterable<string> = []): string | null {
  if (!content) return null;
  const outside = outsideCode(content).trim();
  if (outside) {
    for (const b of BLOCKS) {
      const open = b.open.exec(outside);
      if (!open) continue;
      const rest = outside.slice(open.index + open[0].length);
      const close = b.close?.exec(rest);
      const end = close ? open.index + open[0].length + close.index + close[0].length : outside.length;
      const block = end - open.index;
      // The reply starts with the call, or the call is most of the reply.
      if (open.index === 0 || block >= outside.length * 0.5) return b.format;
    }
  }
  return wholeReplyIsCallJson(content, new Set(toolNames)) ? 'function-call JSON' : null;
}

/** The step's error code in the run report. */
export const TEXT_TOOL_CALL_CODE = 'text_tool_call';

/** The short corrective note the model gets once, after a reply that wrote a tool call as text. */
export const TEXT_TOOL_CALL_PROMPT =
  'SYSTEM NOTE: your last reply wrote a tool call as text instead of calling the tool. It was not run. ' +
  'Call tools only through the tools interface (a real function call), never as text in your reply. ' +
  'If you need no tool, write your final answer as plain prose.';

/** The step result recorded for such a reply (the model was asked once more, or the step failed). */
export function textToolCallResult(format: string, final: boolean): string {
  return JSON.stringify({
    error: {
      code: TEXT_TOOL_CALL_CODE,
      reason: `The model wrote a tool call as text (${format}) instead of calling it; it was not run. ${final ? 'It did so again after being told, so the step failed.' : 'It was asked once more to call the tool properly.'}`,
    },
  });
}

/** The typed failure of a step whose model wrote a tool call as text instead of answering. Its message is what the run report shows. */
export class TextToolCallError extends Error {
  readonly code = TEXT_TOOL_CALL_CODE;
  readonly format: string;
  constructor(format: string, when: 'again' | 'final' = 'again') {
    super(
      when === 'final'
        ? `the model wrote a tool call as text instead of calling it (${format}) when asked for its final answer — it was not run`
        : `the model wrote a tool call as text instead of calling it (${format}), again after being told to use the tools interface — it was not run`,
    );
    this.name = 'TextToolCallError';
    this.format = format;
  }
}
