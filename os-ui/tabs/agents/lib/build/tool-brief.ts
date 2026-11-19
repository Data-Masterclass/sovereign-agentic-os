/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    One-line tool summaries for an agent's system prompt
 * USER STORY: As the owner of an agent system I want each model call to carry every tool's long
 *             description ONCE, not three times, so a trivial run does not spend most of its
 *             tokens re-reading the manual.
 * ARCHITECTURE:
 *   - A tool's full description (100–300 words: purpose, golden path, governance, honesty notes)
 *     reaches the model in the `tools` schema of every request — that is where a model that calls
 *     tools natively reads it. The system prompt used to repeat all of it twice more: in the
 *     grant-scoped "YOUR GRANTED TOOLS" brief and in the per-node "Available tools" list.
 *   - The prompt now carries the AUTHORITATIVE LIST — every tool's name, so the "only these tools"
 *     rule is as strict as before — with a one-line summary: the description's first sentence,
 *     hard-capped. The schema keeps the full text.
 *   - The ReAct fallback (a model without native tool-calling gets no `tools` schema at all) is
 *     the one place the prompt is the ONLY carrier, so it keeps the full descriptions.
 *   - Pure: no `server-only`, so the engine (`build-graph.ts`) and the server-side brief
 *     (`os-tools.ts`) share one rule.
 */
import type { ToolSpec } from '@core/runtime/agentic';

/** Hard cap on a tool's one-line summary in the system prompt. */
export const TOOL_SUMMARY_MAX_CHARS = 120;

/** A sentence end: `.`/`!`/`?` followed by whitespace and a new sentence, or the end of the text. */
const SENTENCE_END = /[.!?](?=\s+[A-Z`"'(\[]|\s*$)/g;
/** Abbreviations whose period is not a sentence end. */
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|incl|approx|no)\.$/i;

/**
 * The one-line summary of a tool description: its first sentence, at most `max` characters
 * (cut at a word boundary with an ellipsis). Never empty for a non-empty description.
 */
export function toolSummary(description: string, max: number = TOOL_SUMMARY_MAX_CHARS): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  let sentence = text;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(text); m; m = SENTENCE_END.exec(text)) {
    const candidate = text.slice(0, m.index + 1);
    if (ABBREVIATION.test(candidate)) continue;
    sentence = candidate;
    break;
  }
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max * 0.6 ? cut.slice(0, atWord) : cut).replace(/[\s,;:(—–-]+$/, '')}…`;
}

/** The same tools with each description reduced to its one-line summary (names and schemas untouched). */
export function briefToolSpecs(tools: ToolSpec[]): ToolSpec[] {
  return tools.map((t) => ({ ...t, description: toolSummary(t.description) }));
}
