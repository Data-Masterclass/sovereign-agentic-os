/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    Record / replay model caller — identical model outputs for two engines
 * USER STORY: As the engineer rebuilding the agent engine I want to record every model exchange
 *             a run makes once, then feed the SAME responses to the old walker and the new
 *             LangGraph engine, so a difference in visited path, tool calls or final text can
 *             only come from the engine — never from the model.
 * ARCHITECTURE:
 *   - Pure wrappers around the injected `LlmCall` (`core/runtime/agentic.ts`): no fetch, no fs.
 *     `recordingCaller` forwards to an inner caller and appends `(request → response)` to a
 *     sink; `replayCaller` serves a transcript in order.
 *   - A recorded request keeps only what both engines must agree on — the MODEL and the
 *     advertised TOOL-SET (sorted names) — plus the message count for the human reader. Prompt
 *     text is deliberately NOT asserted: the two engines compose prompts differently by design.
 *   - Replay fails LOUDLY: a request past the end of the transcript, or one whose model/tool-set
 *     differs from what was recorded, throws a typed error naming the exchange index and both
 *     sides. A fixture that is silently reinterpreted would make the parity test lie.
 *   - Fixtures live as JSON under `tabs/agents/lib/engine/fixtures/`; this module only defines
 *     the shape (`LlmTranscript`) and the two callers.
 */
import type { LlmCall, LlmCompletion, LlmRequest } from '@core/runtime/agentic';

/** What the replayer asserts on: the model and the sorted tool names (never the prompt). */
export type RecordedRequest = {
  model: string;
  /** Sorted, de-duplicated names of the tools advertised on this call ([] when none). */
  tools: string[];
  /** Number of messages on the wire — informational, never asserted. */
  messages: number;
};

export type RecordedExchange = { request: RecordedRequest; response: LlmCompletion };

export type LlmTranscript = { version: 1; exchanges: RecordedExchange[] };

/** Project a live request to its recorded shape. */
export function describeRequest(req: LlmRequest): RecordedRequest {
  const names = (req.tools ?? []).map((t) => t.function.name);
  return { model: req.model, tools: [...new Set(names)].sort(), messages: req.messages.length };
}

/**
 * Wrap `inner` so every exchange is appended to `sink` (an array or a callback) AFTER the
 * inner call resolves. Responses are deep-copied into the record so a caller that mutates
 * the completion cannot alter the transcript. A rejected inner call records nothing.
 */
export function recordingCaller(
  inner: LlmCall,
  sink: RecordedExchange[] | ((exchange: RecordedExchange) => void),
): LlmCall {
  const push = typeof sink === 'function' ? sink : (ex: RecordedExchange) => { sink.push(ex); };
  return async (req) => {
    const response = await inner(req);
    push({ request: describeRequest(req), response: structuredClone(response) });
    return response;
  };
}

export class ReplayExhaustedError extends Error {
  index: number;
  request: RecordedRequest;
  constructor(index: number, request: RecordedRequest) {
    super(
      `llm-replay: transcript exhausted — request #${index + 1} (model '${request.model}', tools [${request.tools.join(', ')}]) ` +
        `has no recorded exchange`,
    );
    this.name = 'ReplayExhaustedError';
    this.index = index;
    this.request = request;
  }
}

export class ReplayMismatchError extends Error {
  index: number;
  expected: RecordedRequest;
  actual: RecordedRequest;
  constructor(index: number, expected: RecordedRequest, actual: RecordedRequest) {
    super(
      `llm-replay: request #${index + 1} differs from the recording — ` +
        `expected model '${expected.model}' tools [${expected.tools.join(', ')}], ` +
        `got model '${actual.model}' tools [${actual.tools.join(', ')}]`,
    );
    this.name = 'ReplayMismatchError';
    this.index = index;
    this.expected = expected;
    this.actual = actual;
  }
}

/** An `LlmCall` that serves a transcript, plus accessors for how far it got. */
export type ReplayCaller = LlmCall & {
  /** Exchanges served so far. */
  consumed: () => number;
  /** Exchanges still unserved — a parity test asserts 0, proving the engine made every call. */
  remaining: () => number;
};

function sameTools(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/**
 * Serve the recorded responses IN ORDER. Each incoming request must match the next recorded
 * request's model and tool-set, else {@link ReplayMismatchError}; a request after the last
 * exchange throws {@link ReplayExhaustedError}. Responses are deep-copied per call.
 */
export function replayCaller(transcript: LlmTranscript | RecordedExchange[]): ReplayCaller {
  const exchanges = Array.isArray(transcript) ? transcript : transcript.exchanges;
  let cursor = 0;
  const call: LlmCall = async (req) => {
    const actual = describeRequest(req);
    const index = cursor;
    if (index >= exchanges.length) throw new ReplayExhaustedError(index, actual);
    const expected = exchanges[index].request;
    if (expected.model !== actual.model || !sameTools(expected.tools, actual.tools)) {
      throw new ReplayMismatchError(index, expected, actual);
    }
    cursor += 1;
    return structuredClone(exchanges[index].response);
  };
  return Object.assign(call, {
    consumed: () => cursor,
    remaining: () => exchanges.length - cursor,
  });
}
