/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * BUILD-STAGE STREAM — the client-side SSE decoder for the Stage-3 Build run.
 *
 * The `/api/apps/[id]/chat` route streams `text/event-stream` events, each a
 * `data: <json>\n\n` frame. This decodes a byte stream into typed events and
 * dispatches them to a handler as they arrive. Kept as a small PURE parser
 * (`parseSseFrames`) plus a thin reader wrapper so the frame-splitting is
 * unit-tested without a DOM/network.
 */
import type { ActivityLine } from './build-activity';
import type { FileChange } from './build-changeset';

export type BuildStreamEvent =
  | { type: 'plan'; text: string }
  | { type: 'activity'; line: ActivityLine; raw?: { tool: string; args: unknown; result: string } }
  | { type: 'final'; role: 'assistant'; content: string; finalText?: string; model?: string; mode?: string; changes?: FileChange[] }
  | { type: 'error'; message: string };

/**
 * Split a chunk of accumulated SSE text into complete events + the unparsed
 * remainder. Frames are separated by a blank line (`\n\n`); each frame's payload
 * is the concatenation of its `data:` lines. Returns the decoded events and the
 * leftover partial frame to carry into the next chunk. PURE + unit-tested.
 */
export function parseSseFrames(buffer: string): { events: BuildStreamEvent[]; rest: string } {
  const events: BuildStreamEvent[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? ''; // last part is either '' or an incomplete frame
  for (const frame of parts) {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data) continue;
    try {
      const obj = JSON.parse(data);
      if (obj && typeof obj.type === 'string') events.push(obj as BuildStreamEvent);
    } catch {
      /* skip a malformed frame rather than break the whole stream */
    }
  }
  return { events, rest };
}

/**
 * Read a fetch Response body as an SSE stream, invoking `onEvent` for each decoded
 * event as it arrives. Resolves when the stream ends. Aborting the underlying
 * fetch rejects the read with an AbortError, which the caller handles.
 */
export async function consumeBuildStream(
  res: Response,
  onEvent: (e: BuildStreamEvent) => void,
): Promise<void> {
  const body = res.body;
  if (!body) {
    // No stream (shouldn't happen for our route) — try a one-shot JSON fallback so
    // an unexpected non-streaming response still surfaces a final message.
    const text = await res.text();
    const { events } = parseSseFrames(text.endsWith('\n\n') ? text : `${text}\n\n`);
    for (const e of events) onEvent(e);
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseFrames(buffer);
    buffer = rest;
    for (const e of events) onEvent(e);
  }
  // Flush any trailing complete frame left without a final blank line.
  if (buffer.trim()) {
    const { events } = parseSseFrames(`${buffer}\n\n`);
    for (const e of events) onEvent(e);
  }
}
