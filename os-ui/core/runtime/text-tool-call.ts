/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents (shared runtime helper)
 * FEATURE:    Recognise a tool call a model WROTE AS TEXT in its reply instead of making it through the
 *             tools interface — so an agent run never presents it as the answer.
 * USER STORY: As the owner I never see `<tool_call>{"name": …}</tool_call>` as my agent's final answer
 *             (dev, 23 Nov 2026: the strong model wrote its call into the reply's text and the engine
 *             showed that text as the result).
 * ARCHITECTURE:
 *   - DETECTION ONLY. Nothing here parses a call to run it: a call that never went through the tools
 *     interface never went through the gateway's `allowed_tools` check either, so the OS does not
 *     execute it. The caller (the agent engine, the module engine's middleware) asks the model once
 *     more with {@link TEXT_TOOL_CALL_PROMPT} and fails the step with {@link TextToolCallError} if
 *     it happens again.
 *   - The shapes are the chat templates' own tool-call markup, as each model family documents it:
 *       · Qwen / Hermes template (Qwen2.5, Qwen3, Qwen3-VL): `<tool_call>{"name": …, "arguments": …}</tool_call>`,
 *         and Qwen3-Coder's XML body `<tool_call><function=name><parameter=…>`;
 *       · Kimi K2: `<|tool_calls_section_begin|><|tool_call_begin|>functions.name:0<|tool_call_argument_begin|>{…}`;
 *       · DeepSeek V3 / V3.1 / R1: `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>…<｜tool▁sep｜>…` (full-width bars);
 *       · gpt-oss (harmony): `<|channel|>commentary to=functions.name … <|message|>{…}<|call|>`;
 *       · `<|tool_call|>` (Phi-4-mini, Granite) and Mistral's `[TOOL_CALLS]`;
 *       · a reply that is NOTHING BUT an OpenAI-style function-call object: `{"name": …, "arguments"|"parameters": {…}}`,
 *         `{"type": "function", "function": {…}}`, `{"tool_calls": [...]}`, `{"function_call": {…}}` (or a list of them).
 *     The JSON shape counts only when the whole reply is that object, so an answer that merely
 *     quotes JSON is not mistaken for a call.
 *   - Read the RAW model text where possible: `parseLlmMessage` strips `<|…|>` control tokens from
 *     `content`, so it records the detection on the completion (`textToolCall`) before stripping.
 */

/** Markup that only a chat template's tool-call syntax produces. */
const MARKERS: { format: string; re: RegExp }[] = [
  { format: 'qwen/hermes <tool_call>', re: /<\/?tool_call>/i },
  { format: 'xml body <function=…>', re: /<function=[A-Za-z_][\w.-]*>/ },
  { format: 'kimi <|tool_call_begin|>', re: /<\|tool_calls?_(?:section_)?begin\|>|<\|tool_call_argument_begin\|>/ },
  { format: 'deepseek <｜tool▁call▁begin｜>', re: /<[|｜]tool[▁_ ]calls?[▁_ ]begin[|｜]>|<[|｜]tool[▁_ ]sep[|｜]>/ },
  { format: 'harmony to=functions.…', re: /<\|channel\|>\s*commentary\s+to=|\bto=functions\.[A-Za-z_]|<\|call\|>/ },
  { format: '<|tool_call|>', re: /<\|tool_call\|>/ },
  { format: 'mistral [TOOL_CALLS]', re: /\[TOOL_CALLS\]/ },
];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const IDENT = /^[A-Za-z_][\w.-]*$/;

/** One OpenAI-/Llama-style function-call object (not a data object that happens to have a `name`). */
function isCallObject(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (Array.isArray(v.tool_calls) && v.tool_calls.length > 0) return v.tool_calls.every(isCallObject);
  if (isRecord(v.function_call)) return isCallObject(v.function_call);
  if (v.type === 'function' && isRecord(v.function)) return isCallObject(v.function);
  if (typeof v.name !== 'string' || !IDENT.test(v.name)) return false;
  const args = v.arguments ?? v.parameters;
  if (!(isRecord(args) || typeof args === 'string')) return false;
  // Nothing else but the call's own fields: a record like {"name": "Acme", "parameters": {…}, "revenue": 3} is data.
  return Object.keys(v).every((k) => ['name', 'arguments', 'parameters', 'id', 'type'].includes(k));
}

/** The reply, without a surrounding ``` fence, is one function-call object (or a list of them). */
function wholeReplyIsCallJson(text: string): boolean {
  let body = text.trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) body = fenced[1].trim();
  if (!(body.startsWith('{') || body.startsWith('['))) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed.length > 0 && parsed.every(isCallObject) : isCallObject(parsed);
  } catch {
    return false;
  }
}

/**
 * The tool-call format a model wrote as text in `content`, or null when the reply contains none.
 * Detection only — the call is never parsed to be run.
 */
export function detectTextToolCall(content: string): string | null {
  if (!content) return null;
  for (const m of MARKERS) if (m.re.test(content)) return m.format;
  return wholeReplyIsCallJson(content) ? 'function-call JSON' : null;
}

/** The step's error code in the run report. */
export const TEXT_TOOL_CALL_CODE = 'text_tool_call';

/** The short corrective note the model gets once, after a reply that wrote a tool call as text. */
export const TEXT_TOOL_CALL_PROMPT =
  'SYSTEM NOTE: your last reply wrote a tool call as text instead of calling the tool. Nothing was run. ' +
  'Call tools only through the tools interface (a real function call), never as text in your reply. ' +
  'If you need no tool, write your final answer as plain prose.';

/** The step result recorded for such a reply (the model was asked once more, or the step failed). */
export function textToolCallResult(format: string, final: boolean): string {
  return JSON.stringify({
    error: {
      code: TEXT_TOOL_CALL_CODE,
      reason: `The model wrote a tool call as text (${format}) instead of calling it; nothing was run. ${final ? 'It did so again after being told, so the step failed.' : 'It was asked once more to call the tool properly.'}`,
    },
  });
}

/** The typed failure of a step whose model wrote a tool call as text twice. Its message is what the run report shows. */
export class TextToolCallError extends Error {
  readonly code = TEXT_TOOL_CALL_CODE;
  readonly format: string;
  constructor(format: string) {
    super(`the model wrote a tool call as text instead of calling it (${format}), again after being told to use the tools interface — nothing was run`);
    this.name = 'TextToolCallError';
    this.format = format;
  }
}
