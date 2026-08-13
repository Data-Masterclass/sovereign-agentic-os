/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The PURE "Generate my app" build assistant (0.6.131).
 *
 * PROBLEM: the Build stage dropped the user into an EMPTY composer — there was no assistant that
 * builds the app UP from the epics/user-stories/requirements they already designed. This module is
 * the DOM-free, store-free heart of the fix: two pure functions the route wires model IO around.
 *
 *   • `buildGeneratePrompt(material)` — folds the app's GRANTED context (datasets + their REAL
 *     columns, metrics, agents) and its epics/stories into a constrained system+user prompt that
 *     instructs the OS reasoning model to emit a JSON AppSpec (v2) whose tabs are chosen ONLY from
 *     the cookbook patterns, wired ONLY to granted ids + real columns, each tab linked to the
 *     story it satisfies (Tab.stories).
 *   • `parseGeneratedSpec(rawText)` — recovers the JSON from a reasoning-model reply (which wraps it
 *     in prose — the known landmine) with the tolerant `parseJsonReply`, then runs the STRUCTURAL
 *     gate `parseAppSpec`. The SEMANTIC gate (ungranted id / fabricated column against the real
 *     stores) is `validateAppSpec`, run by the route — this module never touches a store.
 *   • `repairInstruction(issues)` — the one-turn repair seed: the exact issues to fix, verbatim.
 *
 * DESIGN LAW (see DESIGN.md): SAFE + LOW-VARIANCE. Everything the generator is ASKED to emit is
 * constrained to the closed grammar; whatever it returns is still gated by parseAppSpec +
 * validateAppSpec before it can persist, so a hallucinated id/column can never reach the renderer.
 */

import { parseAppSpec, type AppSpec, type SpecIssue } from './schema.ts';
import { PATTERNS, PATTERN_IDS, isImplementedPattern } from './patterns.ts';
import { parseJsonReply } from '@/lib/assistant/json-reply.ts';

/** A granted dataset with its REAL columns (the route resolves columns via peekDatasetColumns). */
export type GenerateDataset = { id: string; name: string; columns: string[] };
/** A granted metric or agent — id + display name (no columns). */
export type GenerateGrant = { id: string; name: string };
/** One user story, flattened with its Design spec lists (features / nfrs / rules). */
export type GenerateStory = {
  id: string;
  title: string;
  features: string[];
  nfrs: string[];
  rules: string[];
};
/** One epic with its stories. */
export type GenerateEpic = { id: string; title: string; stories: GenerateStory[] };

/** The full material the generator cooks from — all already-governed, granted-only. */
export type GenerateMaterial = {
  appName: string;
  appDescription: string;
  grantedDatasets: GenerateDataset[];
  grantedMetrics: GenerateGrant[];
  grantedAgents: GenerateGrant[];
  epics: GenerateEpic[];
};

/** The prompt the route sends to the model: a system frame + the app-specific user brief. */
export type GeneratePrompt = { system: string; user: string };

/** The result of recovering + structurally-gating a model reply. */
export type GenerateParse = { ok: true; spec: AppSpec } | { ok: false; issues: SpecIssue[] };

/**
 * Enumerate the IMPLEMENTED cookbook patterns with a one-line description of what each renders and
 * the config keys it needs. Coming-soon patterns are OMITTED so the model is never asked to emit one.
 * The grammar in schema.ts / patterns.ts is the source of truth — this is a compact human summary of
 * the required config per pattern, kept in sync with the parsers by the patterns.test.ts contract.
 */
function patternCatalogue(): string {
  const cfg: Partial<Record<(typeof PATTERN_IDS)[number], string>> = {
    'records-table': 'config: { source:{datasetId}, columns:[{field,label?,format?}], filters?, search?, sort?, pageSize? }',
    detail: 'config: { source:{datasetId}, keyField, fields:[{field,label?,format?}] }',
    'status-board': 'config: { source:{datasetId}, statusField, titleField, subtitleFields?, columns? }',
    'master-detail': 'config: { source:{datasetId}, keyField, listColumns:[{field}], detailFields:[{field}] }',
    'kpi-overview': 'config: { cards:[{ label, metric:{metricId} | dataset:{datasetId,agg,field?} }] }',
    'chart-explorer': "config: { metric:{metricId}, chart:'line'|'bar'|'area', dimensions?, timeDimension?, granularity? }",
    'card-gallery': 'config: { source:{datasetId}, titleField, subtitleField?, fields?, search? }',
    timeline: 'config: { source:{datasetId}, dateField, titleField, descriptionField? }',
    calendar: 'config: { source:{datasetId}, dateField, titleField }',
    landing: "config: { blocks:[{kind:'markdown',content} | {kind:'kpi',cards} | {kind:'table',source:{datasetId},columns}] }",
    form: "config: { target:'records', fields:[{name,label,type:'text'|'number'|'date'|'boolean',required?}], submitLabel? }",
    'intake-wizard': "config: { target:'records', steps:[{title,fields:[...]}], submitLabel }",
    assignment: 'config: { source:{datasetId}, itemLabelField, assignTo:{datasetId,optionLabelField}, extraFields? }',
    'approval-queue': "config: { source:'records'|{datasetId}, titleField, subtitleFields?, decisionField?, reasonRequired? }",
    'task-checklist': "config: { source:'records'|{datasetId}, titleField, assigneeField? }",
  };
  return PATTERN_IDS.filter(isImplementedPattern)
    .map((id) => {
      const def = PATTERNS[id];
      const shape = cfg[id] ?? 'config: (see grammar)';
      return `- ${id} (${def.category}): ${def.description} ${shape}`;
    })
    .join('\n');
}

/** Render the granted datasets with their real columns (the only fields a tab may reference). */
function datasetsBlock(datasets: GenerateDataset[]): string {
  if (datasets.length === 0) return '(none granted — you cannot use any dataset-backed pattern)';
  return datasets
    .map((d) => `- datasetId "${d.id}" (${d.name}) — columns: ${d.columns.length ? d.columns.join(', ') : '(unknown — avoid)'}`)
    .join('\n');
}

function grantsBlock(label: string, grants: GenerateGrant[]): string {
  if (grants.length === 0) return `(no ${label} granted)`;
  return grants.map((g) => `- ${label}Id "${g.id}" (${g.name})`).join('\n');
}

function epicsBlock(epics: GenerateEpic[]): string {
  if (epics.length === 0) return '(no epics designed yet)';
  return epics
    .map((e) => {
      const stories = (e.stories ?? [])
        .map((s) => {
          const bits = [
            s.features.length ? `features: ${s.features.join('; ')}` : '',
            s.nfrs.length ? `nfrs: ${s.nfrs.join('; ')}` : '',
            s.rules.length ? `rules: ${s.rules.join('; ')}` : '',
          ].filter(Boolean);
          const spec = bits.length ? ` — ${bits.join(' | ')}` : '';
          return `    • story "${s.id}": ${s.title}${spec}`;
        })
        .join('\n');
      return `- epic "${e.id}": ${e.title}\n${stories}`;
    })
    .join('\n');
}

/**
 * Build the constrained prompt. The SYSTEM frame states the closed-grammar rules + enumerates the
 * cookbook patterns; the USER brief hands over the app's granted material and its epics/stories.
 */
export function buildGeneratePrompt(m: GenerateMaterial): GeneratePrompt {
  const system = [
    'You are the Sovereign OS app-build assistant. You compose a DECLARATIVE app spec (a validated',
    'JSON "AppSpec", version 2) from the tabs the user has designed. You DO NOT write code.',
    '',
    'HARD RULES — a spec that breaks any of these is rejected and wasted:',
    '1. Output ONE JSON object and nothing else. No prose, no markdown fences, no comments.',
    '2. Every tab body is either { kind:"pattern", pattern, config } using a pattern from the',
    '   catalogue below, or you omit it. NEVER invent a pattern id.',
    '3. Reference ONLY the datasetIds, metricIds and columns listed in the brief. NEVER invent a',
    '   dataset id, metric id, agent id, or a column name — use the exact real column names given.',
    '4. Link each tab to the story it satisfies via "stories":[{ "epicId","storyId" }] using the',
    '   exact ids from the brief.',
    '5. Prefer 2–6 focused tabs. Give each a short "label" and, when natural, an emoji "icon".',
    '',
    'AppSpec shape:',
    '{ "version":2, "name":string, "description":string,',
    '  "tabs":[ { "id":string, "label":string, "icon"?:string, "stories"?:[{epicId,storyId}],',
    '            "body":{ "kind":"pattern", "pattern":<id>, "config":<per-pattern> } } ] }',
    '',
    'Cookbook patterns (use ONLY these ids):',
    patternCatalogue(),
  ].join('\n');

  const user = [
    `App name: ${m.appName}`,
    `App description: ${m.appDescription || '(none)'}`,
    '',
    'GRANTED DATASETS (the only data you may wire; use these exact ids + column names):',
    datasetsBlock(m.grantedDatasets),
    '',
    'GRANTED METRICS (for kpi-overview / chart-explorer):',
    grantsBlock('metric', m.grantedMetrics),
    '',
    'GRANTED AGENTS (available to the app):',
    grantsBlock('agent', m.grantedAgents),
    '',
    'EPICS & USER STORIES (build tabs that satisfy these; link each tab to its story ids):',
    epicsBlock(m.epics),
    '',
    'Return the JSON AppSpec now.',
  ].join('\n');

  return { system, user };
}

/**
 * Recover the JSON from a (possibly prose-wrapped) model reply and run the STRUCTURAL gate.
 * Returns the typed spec on success, or the structural issues on failure — never throws.
 */
export function parseGeneratedSpec(raw: string): GenerateParse {
  const obj = parseJsonReply(raw);
  if (obj === null || typeof obj !== 'object') {
    return {
      ok: false,
      issues: [{ path: '', reason: 'the model did not return a JSON app spec', fix: 'return one JSON AppSpec object and nothing else' }],
    };
  }
  const parsed = parseAppSpec(obj);
  return parsed.ok ? { ok: true, spec: parsed.spec } : { ok: false, issues: parsed.issues };
}

/**
 * The ONE-turn repair seed: a compact instruction listing the exact issues to fix, so the model's
 * second attempt is grounded in what failed rather than starting over. Pure — the route appends it as
 * a follow-up user message.
 */
export function repairInstruction(issues: SpecIssue[]): string {
  const lines = issues
    .slice(0, 20)
    .map((i) => `- ${i.path || '(root)'}: ${i.reason} → ${i.fix}`)
    .join('\n');
  return [
    'Your previous JSON was rejected. Fix EXACTLY these issues and return the corrected JSON AppSpec',
    '(one JSON object, no prose). Do not introduce new datasetIds, metricIds or columns:',
    lines,
  ].join('\n');
}
