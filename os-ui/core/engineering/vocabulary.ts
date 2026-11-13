/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view
 * FEATURE:    The vocabulary rule — the tool's noun first, the OS noun in parentheses at most once
 * USER STORY: As an engineer I want the "Under the hood" panel to call things what the tools call
 *             them — "dbt metric", not "KPI definition" — so that what I read here matches what I
 *             read in the repo, in the Dagster UI and in `dbt ls` (checklist T2).
 * ARCHITECTURE:
 *   - PURE and DATA-DRIVEN: the allowed nouns are a table, so the test is a loop over a view and a
 *     new noun is one row rather than a code change.
 *   - The rule: any label on this surface that uses an OS-invented noun must ALSO carry the tool's
 *     own noun, and the OS noun appears in parentheses at most once. A label that uses only the
 *     OS noun fails `vocabularyViolations`, which both the panel copy test and every adapter test
 *     run (there is no second implementation to drift).
 */
import type { EngineeringTool, EngineeringView } from '@core/engineering/types';

/** The tools' own nouns, exactly as the tools write them. Case-sensitive on purpose. */
export const TOOL_NOUNS: Record<EngineeringTool, readonly string[]> = {
  dbt: ['dbt model', 'dbt metric', 'dbt source', 'dbt test', 'dbt project', 'dbt semantic model', 'dbt seed', 'dbt snapshot', 'dbt exposure'],
  dagster: ['Dagster asset', 'Dagster job', 'Dagster schedule', 'Dagster run', 'Dagster sensor', 'Dagster code location', 'Dagster asset check'],
  langgraph: ['LangGraph graph', 'LangGraph node', 'LangGraph edge', 'LangGraph channel', 'LangGraph thread', 'LangGraph checkpointer', 'LangGraph interrupt'],
  git: ['git repository', 'git commit', 'git file', 'git tag', 'git ref', 'git tree'],
  langfuse: ['Langfuse trace', 'Langfuse observation', 'Langfuse score'],
  trino: ['Trino query', 'Trino catalog', 'Trino schema', 'Trino table'],
  litellm: ['LiteLLM key alias', 'LiteLLM route', 'LiteLLM model', 'LiteLLM tag', 'LiteLLM budget'],
};

/** The tab label of each tool — the tool's own name and nothing else. */
export const TOOL_LABELS: Record<EngineeringTool, string> = {
  dbt: 'dbt',
  dagster: 'Dagster',
  langgraph: 'LangGraph',
  git: 'git',
  langfuse: 'Langfuse',
  trino: 'Trino',
  litellm: 'LiteLLM',
};

/**
 * The OS's nouns for the five object KINDS — the words the owner objected to reading where a
 * tool's noun belongs. The panel's own frame (its heading and section headings) may not use these
 * at all: a frame that says "data product" is describing the OS, not the tool.
 */
export const OS_KIND_NOUNS: readonly string[] = ['data product', 'dataset', 'KPI', 'dashboard', 'agent system', 'app'];

/**
 * Every OS noun: the kinds plus the OS's other words for a tool's object. Allowed as the bridge in
 * parentheses, never alone.
 */
export const OS_NOUNS: readonly string[] = [
  ...OS_KIND_NOUNS,
  'metric definition',
  'AI team',
  'application',
  'pipeline',
  'run',
  'workflow',
];

const lower = (s: string) => s.toLowerCase();

/** Does this label carry the tool's own noun? */
export function hasToolNoun(tool: EngineeringTool, label: string): boolean {
  return TOOL_NOUNS[tool].some((n) => lower(label).includes(lower(n)));
}

/** Does this label carry an OS-invented noun (outside parentheses counts too)? */
export function hasOsNoun(label: string): boolean {
  return OS_NOUNS.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(label));
}

/**
 * Every way one label can break the rule:
 *   · an OS noun with no tool noun beside it
 *   · the bridge used more than once (two parenthesised asides read as OS vocabulary again)
 */
export function labelViolations(tool: EngineeringTool, where: string, label: string): string[] {
  const out: string[] = [];
  if (hasOsNoun(label) && !hasToolNoun(tool, label)) {
    out.push(`${where}: "${label}" uses an OS noun with no ${TOOL_LABELS[tool]} noun beside it`);
  }
  const brackets = (label.match(/\(/g) ?? []).length;
  if (brackets > 1) out.push(`${where}: "${label}" uses the OS term in parentheses ${brackets} times; at most once`);
  return out;
}

/**
 * The whole rule over a whole view: section titles, artefact nouns and link labels. Returns every
 * violation (never just the first) so a failing test names all of them at once.
 */
export function vocabularyViolations(view: EngineeringView): string[] {
  const out: string[] = [];
  for (const s of view.sections) {
    if (s.label !== TOOL_LABELS[s.tool]) {
      out.push(`${view.kind}:${view.id} ${s.tool}: the tab label must be "${TOOL_LABELS[s.tool]}", found "${s.label}"`);
    }
    if (!hasToolNoun(s.tool, s.title)) {
      out.push(`${view.kind}:${view.id} ${s.tool}: the title "${s.title}" names no ${TOOL_LABELS[s.tool]} noun (allowed: ${TOOL_NOUNS[s.tool].join(', ')})`);
    }
    out.push(...labelViolations(s.tool, `${view.kind}:${view.id} ${s.tool} title`, s.title));
    for (const a of s.artefacts) {
      if (!hasToolNoun(s.tool, a.noun)) {
        out.push(`${view.kind}:${view.id} ${s.tool}: the artefact noun "${a.noun}" is not one of ${TOOL_NOUNS[s.tool].join(', ')}`);
      }
      out.push(...labelViolations(s.tool, `${view.kind}:${view.id} ${s.tool} artefact`, a.noun));
    }
    for (const l of s.links) out.push(...labelViolations(s.tool, `${view.kind}:${view.id} ${s.tool} link`, l.label));
  }
  return out;
}

/**
 * The panel's own frame — its heading, its section headings, its loading and error copy — must not
 * name an object KIND at all: those strings sit above every tool's section, so an OS kind noun
 * there would re-label every artefact underneath it. (The neutral word "artefact" is deliberate:
 * it is the plan's own word for "the real thing", not a rename of anyone's object.)
 */
export function frameCopyViolations(copy: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, text] of Object.entries(copy)) {
    for (const noun of OS_KIND_NOUNS) {
      if (new RegExp(`\\b${noun}\\b`, 'i').test(text)) out.push(`${key}: the panel frame names the OS kind "${noun}" — "${text}"`);
    }
  }
  return out;
}
