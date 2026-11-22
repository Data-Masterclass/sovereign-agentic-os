/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Streamed model replies — chat-completions SSE into one completion, token by token
 * USER STORY: As a user I want the answer to appear as the model writes it, and the finished
 *             answer to be exactly what a non-streamed call would have returned.
 * ARCHITECTURE:
 *   - Pure: reads a `ReadableStream` of the OpenAI-shaped server-sent events LiteLLM forwards
 *     (https://platform.openai.com/docs/api-reference/chat-streaming) and returns the same
 *     `LlmCompletion` the non-streamed path builds with `parseLlmMessage`. The caller
 *     (`runtime.ts`) owns the request, the key and the errors.
 *   - Usage comes from the final chunk (`stream_options.include_usage`); absent stays absent.
 */
import type { LlmCompletion } from '@core/runtime/agentic';

const HARMONY = /<\|[^|]*\|>/g;

type Delta = { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };

/** The two parsers of `runtime.ts`, handed in so a streamed reply ends in EXACTLY the completion a non-streamed one would. */
export type StreamParsers = {
  message: (message: Record<string, unknown>, finishReason?: unknown) => LlmCompletion;
  usage: (raw: unknown) => { input: number; output: number; total: number } | undefined;
};

export async function assembleStream(body: ReadableStream<Uint8Array>, parsers: StreamParsers, onToken?: (text: string) => void): Promise<LlmCompletion> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let finish: string | undefined;
  let usage: unknown;
  let malformed = 0;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  const handle = (data: string) => {
    if (data === '[DONE]') return;
    let j: { choices?: { delta?: Delta; finish_reason?: string | null }[]; usage?: unknown; error?: { message?: string } } | null = null;
    try {
      j = JSON.parse(data);
    } catch {
      malformed += 1; // dropped, never shown as text; counted
    }
    if (!j) return;
    if (j.error) throw new Error(`LiteLLM stream error: ${String(j.error.message ?? 'unknown').slice(0, 300)}`);
    if (j.usage) usage = j.usage;
    const c = j.choices?.[0];
    if (!c) return;
    if (c.finish_reason) finish = c.finish_reason;
    const d = c.delta ?? {};
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      const clean = d.content.replace(HARMONY, '');
      if (clean) onToken?.(clean);
    }
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    for (const t of d.tool_calls ?? []) {
      const i = t.index ?? 0;
      const cur = calls.get(i) ?? { id: '', name: '', arguments: '' };
      if (t.id) cur.id = t.id;
      if (t.function?.name) cur.name += t.function.name;
      if (t.function?.arguments) cur.arguments += t.function.arguments;
      calls.set(i, cur);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: !done });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
    if (done) break;
  }
  if (buf.startsWith('data:')) handle(buf.slice(5).trim());

  const message = {
    content,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.size > 0
      ? { tool_calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
      : {}),
  };
  if (malformed > 0 && !content && calls.size === 0) throw new Error(`LiteLLM stream carried no readable event (${malformed} malformed)`);
  const completion = parsers.message(message, finish);
  const u = parsers.usage(usage);
  return u ? { ...completion, usage: u } : completion;
}
