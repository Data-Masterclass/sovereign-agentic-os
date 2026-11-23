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

// ------------------------------------------------------------------ compact definitions for agent runs

/** The sentences of a text (the same sentence rule as {@link toolSummary}). */
function sentencesOf(text: string): string[] {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  let from = 0;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(t); m; m = SENTENCE_END.exec(t)) {
    const candidate = t.slice(from, m.index + 1);
    if (ABBREVIATION.test(candidate)) continue;
    out.push(candidate.trim());
    from = m.index + 1;
  }
  if (from < t.length && t.slice(from).trim()) out.push(t.slice(from).trim());
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `text` name one of `tools`? A name with an underscore counts as a whole word (`list_files`); a one-word
 * name (`find`, `commit`) only in code (`` `find` ``) or as a call (`find(`), so plain English is not a mention.
 */
export function mentionsTool(text: string, tools: Iterable<string>): string | null {
  for (const name of tools) {
    const n = escapeRe(name);
    const re = name.includes('_') ? new RegExp(`(?<![\\w-])${n}(?![\\w-])`) : new RegExp(`\`${n}\`|(?<![\\w-])${n}\\(`);
    if (re.test(text)) return name;
  }
  return null;
}

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v);

/** A mention pattern for one tool name (the same rule as {@link mentionsTool}), global, for removal. */
function mentionRe(name: string): RegExp {
  const n = escapeRe(name);
  return name.includes('_') ? new RegExp(`(?<![\\w-])${n}(?![\\w-])`, 'g') : new RegExp(`\`${n}\`|(?<![\\w-])${n}\\(\\)?`, 'g');
}

/**
 * Remove ONLY the clause that names a tool this agent is not offered, keeping the rest of the sentence (formats,
 * examples): a parenthesis naming it, a "from/via/after/before/see/use/call … X (/ Y)" phrase, a "X → field" reference;
 * a bare name left after that becomes "another OS tool". The text never names a foreign tool afterwards.
 */
export function stripForeignMentions(text: string, foreign: readonly string[]): string {
  if (!mentionsTool(text, foreign)) return text;
  let out = text;
  for (const name of foreign) {
    if (!mentionsTool(out, [name])) continue;
    const n = escapeRe(name);
    const word = name.includes('_') ? `\`?${n}\`?` : `\`${n}\`|${n}\\(\\)`;
    // A parenthesis that names it: "(from list_metrics)" / "(see get_dataset → queryable.fqn)".
    out = out.replace(new RegExp(`\\s*\\([^()]*?(?:${word})[^()]*\\)`, 'g'), '');
    // A lead-in phrase: "from list_files / search_files", "via get_dataset → `queryable.fqn`", "call X first".
    out = out.replace(new RegExp(`[,;]?\\s*\\b(?:from|via|after|before|see|use|using|call|calling|then|with|returned by|as returned by)\\s+(?:${word})(?:\\s*(?:→|->)\\s*\\S+)?(?:\\s*(?:/|,|or|and)\\s*\`?[a-z][a-z0-9]*_[a-z0-9_]*\`?(?:\\(\\))?)*`, 'gi'), '');
    out = out.replace(mentionRe(name), 'another OS tool');
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

/** A sentence that is a heading, not a description ("STAGE 1 · DEFINE APP.", "Path: …"). */
function isHeaderLike(sentence: string): boolean {
  const t = sentence.trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 0 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) return true;
  return /^(?:path|purpose|before|after|governance|honesty|note|stage\s*\d+)\s*[:·—-]/i.test(t);
}

/** A schema whose argument descriptions name no foreign tool (only the naming clause goes; the rest is kept). */
function cleanSchema(schema: unknown, foreign: readonly string[], top: boolean): unknown {
  if (Array.isArray(schema)) return schema.map((s) => cleanSchema(s, foreign, false));
  if (!isObj(schema)) return schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (top && k === 'examples') continue; // worked examples are manual, not argument docs
    if (k === 'description' && typeof v === 'string') {
      const kept = stripForeignMentions(v.replace(/\s+/g, ' ').trim(), foreign);
      if (kept) out[k] = kept;
      continue;
    }
    out[k] = cleanSchema(v, foreign, false);
  }
  return out;
}

/**
 * COMPACT TOOL DEFINITIONS for an agent run (never the MCP surface, never the chat): each description becomes its FIRST
 * REAL descriptive sentence (a heading such as "STAGE 1 · DEFINE APP." is skipped), plus the argument docs in the
 * schema, kept in full. In both, only the CLAUSE naming a tool this agent is not offered is removed — a format or an
 * example in the same sentence stays. The manual parts (Purpose / Before / After / Governance / Honesty) are not the
 * first sentence, so they go; the top-level `examples` go. Names and argument shapes are unchanged. `known` is every
 * tool name the OS has (MCP and engine tools), to recognise a mention.
 */
export function compactToolSpecs(specs: readonly ToolSpec[], known: Iterable<string>): ToolSpec[] {
  const offered = new Set(specs.map((s) => s.name));
  const foreign = [...new Set(known)].filter((n) => !offered.has(n)).sort((a, b) => b.length - a.length);
  return specs.map((s) => {
    const sentences = sentencesOf(s.description);
    const first = sentences.find((x) => !isHeaderLike(x)) ?? sentences.join(' ');
    const description = stripForeignMentions(first, foreign) || `${s.name.replace(/_/g, ' ')}.`;
    return { ...s, description, inputSchema: cleanSchema(s.inputSchema, foreign, true) as ToolSpec['inputSchema'] };
  });
}
