/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The run report's "what was written" summary, counting saved outputs too
 * USER STORY: As the person who ran an agent I want "Wrote N" to include the declared outputs the
 *             OS saved for me, so a run that saved its report never says it wrote nothing.
 * ARCHITECTURE:
 *   - Pure, no I/O. The tool-write accounting (`summarizeWriteOutcomes` in `os-tools.ts`) counts
 *     the agents' own write steps; the output saver saves declared outputs AFTER the run, outside
 *     any step. `withSavedOutputs` folds the saved ones into the same summary.
 *   - Idempotent: `wrote[]` keeps ONLY the tool writes, so re-applying it after a later
 *     "Try saving again" recounts from scratch (`wroteTotal` = tool writes + outputs saved now).
 *   - One summary for every door: the run report body and stored last run (`run-service.ts`), the
 *     run store's view (`latest-run.ts`), and MCP `get_agent_run`. The Run panel shows it as is.
 */

export type WriteSummary = {
  line: string;
  /** Direct tool writes, grouped by tab (never the saved outputs). */
  wrote: { tab: string; count: number }[];
  /** Everything the run wrote: direct tool writes + declared outputs saved. */
  wroteTotal: number;
  heldTotal: number;
  /** Declared outputs the output saver saved (state `saved`). Absent on runs recorded before it was counted. */
  outputsSaved?: number;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The one-line, human sentence for a run's writes:
 *   • "Wrote 2 record(s) directly — 2 to My Data."                     (tool writes only — unchanged)
 *   • "Wrote 1 item (1 output saved)."                                  (saved outputs only)
 *   • "Wrote 3 items — 2 directly (2 to My Data), 1 output saved."      (both)
 *   • "1 write awaiting approval in Governance → Inbox."                (held, appended)
 * Empty when nothing was written or held.
 */
export function writeSummaryLine(o: { wrote: { tab: string; count: number }[]; heldTotal: number; outputsSaved?: number }): string {
  const parts: string[] = [];
  const direct = o.wrote.reduce((n, g) => n + g.count, 0);
  const saved = o.outputsSaved ?? 0;
  const groups = o.wrote.map((g) => `${g.count} to My ${g.tab}`).join(', ');
  const savedText = `${saved} ${plural(saved, 'output', 'outputs')} saved`;
  if (direct > 0 && saved === 0) {
    parts.push(`Wrote ${direct} record${plural(direct, '', '(s)')} directly — ${groups}.`);
  } else if (direct === 0 && saved > 0) {
    parts.push(`Wrote ${saved} ${plural(saved, 'item', 'items')} (${savedText}).`);
  } else if (direct > 0 && saved > 0) {
    const total = direct + saved;
    parts.push(`Wrote ${total} items — ${direct} directly (${groups}), ${savedText}.`);
  }
  if (o.heldTotal > 0) {
    parts.push(`${o.heldTotal} write${plural(o.heldTotal, '', 's')} awaiting approval in Governance → Inbox.`);
  }
  return parts.join(' ');
}

/**
 * `summary` with the run's SAVED declared outputs counted in. `outputs` absent ⇒ the outputs are
 * unknown, and the summary keeps what it already says. A run with no summary yet gets one.
 */
export function withSavedOutputs(
  summary: Omit<WriteSummary, 'line'> & { line?: string } | undefined,
  outputs: readonly { state: string }[] | undefined,
): WriteSummary {
  const base = summary ?? { wrote: [], wroteTotal: 0, heldTotal: 0 };
  const wrote = Array.isArray(base.wrote) ? base.wrote : [];
  const direct = wrote.reduce((n, g) => n + g.count, 0);
  const outputsSaved = outputs ? outputs.filter((o) => o.state === 'saved').length : base.outputsSaved ?? 0;
  const heldTotal = base.heldTotal ?? 0;
  return {
    line: writeSummaryLine({ wrote, heldTotal, outputsSaved }),
    wrote,
    wroteTotal: direct + outputsSaved,
    heldTotal,
    outputsSaved,
  };
}
