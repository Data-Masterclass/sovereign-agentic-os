/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Bounded, deadlined tool results — the engine's own guardrail on every tool
 * USER STORY: As an engineer whose agent reads a gold dataset I want a 50 000-row answer to be
 *             TRUNCATED before it enters the prompt, with a visible marker and the real row count,
 *             and a hanging or failing tool to come back as a typed error the graph can route on —
 *             never a blown context window and never a hung superstep (checklist X9 b, c).
 * ARCHITECTURE:
 *   - PURE and tool-agnostic. It lives in the engine's tool path, so it protects EVERY tool
 *     (`query_data`, `search_knowledge`, a connector read, anything added later) rather than one
 *     handler. A per-handler bound would still be worth having — see the follow-up in the plan —
 *     but it can never be the only one.
 *   - Row-aware: a result that parses as JSON carrying an array (`rows`, `data`, `items`,
 *     `results`, or a bare array) is truncated BY ROWS, so the model still sees well-formed JSON
 *     plus `[truncated: showing 200 of 50000 rows]`. Anything else is cut by characters, with the
 *     character counts in the marker. The marker is plain text on its own line, so it is visible
 *     in the prompt, in the Run panel's `tool-step` and in the Langfuse span preview.
 *   - The deadline cannot CANCEL an in-flight HTTP call (fetch has no universal abort here), so it
 *     stops WAITING and returns a typed `timeout`. The superstep ends; a late answer is ignored.
 *   - A TIMEOUT IS THEREFORE UNRESOLVED, NOT FAILED (review M-3): the write may have landed. The
 *     engine records the signature as unresolved and answers a repeat of an unresolved WRITE with
 *     {@link unresolvedWriteRepeat} rather than dispatching it again. Reads may always re-run.
 */

/** Default prompt bound for one tool result, in characters (~5k tokens). */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 20_000;
/** Default deadline for ONE tool call, in milliseconds. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/** The error codes the engine itself can produce for a tool call (the graph routes on these). */
export type ToolErrorCode = 'timeout' | 'upstream_error' | 'unresolved_previous_call';

/**
 * A call whose outcome is UNKNOWN — today exactly the deadline (`timeout`): the engine stopped
 * waiting, and whether the tool ran is not knowable from here.
 */
export function isUnresolved(text: string): boolean {
  return toolErrorCode(text) === 'timeout';
}

/**
 * The answer to a model re-issuing a WRITE whose previous attempt never resolved (review M-3).
 *
 * A timeout is not a failure: `insert_rows` that did not answer in 60 s may well have COMMITTED.
 * Re-dispatching it is how one requested write becomes two rows, and the dedup memory did not
 * stop it because it only short-circuits repeats of SUCCESSFUL calls. So an unresolved write
 * signature is answered with this typed note instead — the model is told to verify by READING,
 * which it may always re-dispatch, rather than writing again.
 */
export function unresolvedWriteRepeat(tool: string): ToolOutput {
  return {
    text: JSON.stringify({
      error: {
        code: 'unresolved_previous_call' satisfies ToolErrorCode,
        reason:
          `${tool} was already called with these exact arguments earlier in this run and it did NOT answer before the deadline, ` +
          'so it may well have taken effect. It will NOT be sent again — a repeated write is how one change becomes two. ' +
          'Verify the current state with a READ first, then act on what you find, or report that the outcome is unverified.',
      },
    }),
    isError: true,
  };
}

export type ToolOutput = { text: string; isError: boolean };

/** A typed, model-readable tool error — the same envelope the governed executor uses. */
export function typedToolError(code: ToolErrorCode, reason: string): ToolOutput {
  return { text: JSON.stringify({ error: { code, reason } }), isError: true };
}

/** The `code` of a typed tool-error envelope, or null when the text is not one. */
export function toolErrorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof parsed?.error?.code === 'string' ? parsed.error.code : null;
  } catch {
    return null;
  }
}

export type BoundedResult = {
  text: string;
  truncated: boolean;
  /** Present when the result was truncated BY ROWS. */
  rows?: { kept: number; total: number };
  chars: { kept: number; total: number };
};

const ROW_KEYS = ['rows', 'data', 'items', 'results'] as const;

/** The array a tabular result carries, with the key it sits under (`''` for a bare array). */
function rowsOf(value: unknown): { key: string; rows: unknown[] } | null {
  if (Array.isArray(value)) return { key: '', rows: value };
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  for (const key of ROW_KEYS) {
    if (Array.isArray(obj[key])) return { key, rows: obj[key] as unknown[] };
  }
  return null;
}

/** The largest row count whose serialisation still fits the budget (never more than `total`). */
function fitRows(render: (n: number) => string, total: number, maxChars: number): number {
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Bound one tool result to `maxChars` for the prompt. Returns the text unchanged when it already
 * fits. A truncated result ALWAYS carries a marker naming what was dropped — a silently shortened
 * answer is how an agent comes to a confident wrong conclusion.
 */
export function boundToolResult(text: string, maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS): BoundedResult {
  const total = text.length;
  const budget = Math.max(200, maxChars);
  if (total <= budget) return { text, truncated: false, chars: { kept: total, total } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const table = parsed === undefined ? null : rowsOf(parsed);
  if (table && table.rows.length > 0) {
    const render = (n: number): string => {
      const head = table.rows.slice(0, n);
      const body = table.key === '' ? head : { ...(parsed as Record<string, unknown>), [table.key]: head };
      return JSON.stringify(body);
    };
    // Leave room for the marker line itself.
    const marker = (kept: number) => `\n[truncated: showing ${kept} of ${table.rows.length} rows]`;
    const kept = fitRows(render, table.rows.length, Math.max(100, budget - marker(table.rows.length).length));
    const body = render(kept);
    const out = `${body}${marker(kept)}`;
    return { text: out, truncated: true, rows: { kept, total: table.rows.length }, chars: { kept: out.length, total } };
  }

  const markerFor = (kept: number) => `\n[truncated: showing ${kept} of ${total} characters]`;
  const keep = Math.max(100, budget - markerFor(total).length);
  const out = `${text.slice(0, keep)}${markerFor(keep)}`;
  return { text: out, truncated: true, chars: { kept: out.length, total } };
}

/**
 * Run one tool call under a deadline and bound its result for the prompt.
 *
 * WHAT IT DOES NOT DO: swallow a THROW. The governed executor returns a tool's own failure as a
 * typed `isError` result (an upstream error included — see `os-tools.ts`), so an EXCEPTION out of
 * it means the dispatch itself broke. That has to fail the superstep: the LangGraph checkpoint
 * then holds every call that already ran, and a resume re-runs exactly the one in flight (A2's M5
 * exactly-once property). Turning it into a readable message would tell the model to carry on
 * from a state nobody verified. A TIMEOUT is different — there is no exception to propagate and
 * nothing to resume onto — so it becomes a typed result and the node continues.
 */
export async function callToolGuarded(
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutput>,
  call: { name: string; args: Record<string, unknown> },
  opts: { timeoutMs?: number; maxChars?: number; clock?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } } = {},
): Promise<ToolOutput> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS);
  const clock = opts.clock ?? { setTimeout, clearTimeout };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let out: ToolOutput;
  try {
    out = await Promise.race<ToolOutput>([
      callTool(call.name, call.args),
      new Promise<ToolOutput>((resolve) => {
        timer = clock.setTimeout(
          () => resolve(typedToolError('timeout', `${call.name} did not answer within ${timeoutMs} ms — the step was abandoned, not retried. Try a narrower request (fewer rows, a filter, a smaller range).`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clock.clearTimeout(timer);
  }
  const bounded = boundToolResult(out.text, opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS);
  return bounded.truncated ? { text: bounded.text, isError: out.isError } : out;
}
