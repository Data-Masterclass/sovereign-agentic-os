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
 *   - THE ONE TRUNCATION RULE for tool results. Row-aware: a result that parses as JSON carrying
 *     an array (`rows`, `data`, `items`, `results`, a bare array) — or several, as the
 *     scope-grouped `{ mine, domain, marketplace }` listings do — is truncated BY ROWS, so the
 *     model still sees well-formed JSON plus `[truncated: showing 200 of 50000 rows] <how to
 *     narrow>`. Anything else is cut by characters, with the character counts in the marker. The
 *     marker is plain text on its own line, so it is visible in the prompt, in the Run panel's
 *     `tool-step` and in the Langfuse span preview; `truncationWarnings` turns the same markers
 *     into the run report's warnings.
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

/** One array of rows inside a result, and the key it sits under (`''` for a bare array). */
type RowGroup = { key: string; rows: unknown[] };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The row arrays a result carries. A table (`rows`/`data`/`items`/`results`, or a bare array) is
 * ONE group. Otherwise every top-level array of objects is a group — the scope-grouped listings
 * (`{ mine, domain, marketplace }`) every `list_*` tool answers with. Empty → not tabular.
 */
function rowGroupsOf(value: unknown): RowGroup[] {
  if (Array.isArray(value)) return value.length > 0 ? [{ key: '', rows: value }] : [];
  if (!isRecord(value)) return [];
  for (const key of ROW_KEYS) {
    const rows = value[key];
    if (Array.isArray(rows) && rows.length > 0) return [{ key, rows }];
  }
  return Object.entries(value)
    .filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(isRecord))
    .map(([key, rows]) => ({ key, rows: rows as unknown[] }));
}

/** The largest `n` in [0, max] whose rendering still fits (rendering grows with `n`). */
function largestFitting(render: (n: number) => string, max: number, maxChars: number): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(mid).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * How the model can see the rest — named per tool where there is a real way, generic otherwise.
 * One sentence, so the marker stays one line.
 */
export function narrowHint(tool?: string): string {
  if (tool === 'list_files') return 'Narrow it: call list_files with folder=<a subfolder>, or search_files with a query.';
  if (tool === 'query_data') return 'Narrow it: filter (WHERE), aggregate (GROUP BY) or page (LIMIT/OFFSET) in the SQL.';
  return 'Narrow the request (a filter, a folder or a search) to see the rest — do not treat this as everything.';
}

/** Prefix every truncation marker starts with — what the model, the Run panel and the warnings read. */
export const TRUNCATION_MARKER = '\n[truncated: ';

/**
 * Bound one tool result to `maxChars` for the prompt. Returns the text unchanged when it already
 * fits. A truncated result ALWAYS carries a marker naming what was dropped and how to see it — a
 * silently shortened answer is how an agent comes to a confident wrong conclusion.
 *
 * Row-aware: a tabular result keeps the first rows of EACH group (the same per-group cap), so a
 * grouped listing shows some of every tier instead of being cut mid-JSON; the marker counts every
 * group. Anything else is cut by characters.
 */
export function boundToolResult(text: string, maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS, tool?: string): BoundedResult {
  const total = text.length;
  const budget = Math.max(200, maxChars);
  if (total <= budget) return { text, truncated: false, chars: { kept: total, total } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const groups = rowGroupsOf(parsed);
  const hint = narrowHint(tool);
  if (groups.length > 0) {
    const allRows = groups.reduce((n, g) => n + g.rows.length, 0);
    const largest = Math.max(...groups.map((g) => g.rows.length));
    const render = (perGroup: number): string => {
      if (groups[0].key === '') return JSON.stringify(groups[0].rows.slice(0, perGroup));
      const body: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
      for (const g of groups) body[g.key] = g.rows.slice(0, perGroup);
      return JSON.stringify(body);
    };
    const marker = (perGroup: number) => {
      const shown = groups.reduce((n, g) => n + Math.min(perGroup, g.rows.length), 0);
      const each = groups.length > 1 ? ` (${groups.map((g) => `${g.key} ${Math.min(perGroup, g.rows.length)} of ${g.rows.length}`).join(', ')})` : '';
      return `${TRUNCATION_MARKER}showing ${shown} of ${allRows} rows${each}] ${hint}`;
    };
    // Leave room for the marker line itself (its longest form).
    const perGroup = largestFitting(render, largest, Math.max(100, budget - marker(largest).length));
    const out = `${render(perGroup)}${marker(perGroup)}`;
    const kept = groups.reduce((n, g) => n + Math.min(perGroup, g.rows.length), 0);
    return { text: out, truncated: true, rows: { kept, total: allRows }, chars: { kept: out.length, total } };
  }

  const markerFor = (kept: number) => `${TRUNCATION_MARKER}showing ${kept} of ${total} characters] ${hint}`;
  const keep = Math.max(100, budget - markerFor(total).length);
  const out = `${text.slice(0, keep)}${markerFor(keep)}`;
  return { text: out, truncated: true, chars: { kept: out.length, total } };
}

/**
 * The run warnings for every result the bound cut, one per agent and tool: what a PERSON reads in
 * the run report, next to the marker the model read. Derived from the recorded steps, so it is the
 * same on a live run, a resumed run and a replay.
 */
export function truncationWarnings(runs: { node: string; result: { steps: { tool: string; result: string }[] } }[]): string[] {
  const seen = new Map<string, { count: number; last: string }>();
  for (const r of runs) {
    for (const s of r.result.steps) {
      const at = s.result.lastIndexOf(TRUNCATION_MARKER);
      if (at < 0) continue;
      const what = s.result.slice(at + TRUNCATION_MARKER.length).split(']')[0];
      const key = `${r.node}: ${s.tool}`;
      seen.set(key, { count: (seen.get(key)?.count ?? 0) + 1, last: what });
    }
  }
  return [...seen].map(([key, v]) =>
    `${key} returned more than fits one prompt ${v.count === 1 ? 'once' : `${v.count} times`} (last: ${v.last}); the agent saw only part of it and was told so.`,
  );
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
  const bounded = boundToolResult(out.text, opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS, call.name);
  return bounded.truncated ? { text: bounded.text, isError: out.isError } : out;
}
