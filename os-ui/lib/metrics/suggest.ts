/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The "Suggest metrics" agent (pure core).
 *
 * Given the caller's STRATEGY + OPERATING-MODEL + WORKFLOW context and the datasets
 * they can actually see, propose 3–6 candidate metrics grounded in that context.
 * This is the strategy-aware sibling of {@link ./agent.ts}: agent.ts turns ONE goal on
 * ONE dataset into a metric; this proposes SEVERAL metrics across the datasets the
 * business's strategy implies matter, before a dataset is even chosen.
 *
 * Transport-free by design (the caller makes the LLM call through the ONE governed
 * assistant helper): this module only (a) builds the token-budgeted prompt from the
 * pre-assembled, already-governed context and (b) validates the model's JSON against
 * the REAL context — dropping any candidate whose dataset the caller can't see or
 * whose columns aren't real, so a suggestion can never fabricate access or a column.
 */
import { MEASURE_TYPES, type MeasureType } from '@/lib/data';
import type { MetricForm } from './model.ts';
import type { AssistantMessage } from '../assistant/complete.ts';
import { estimateTokens } from '../knowledge/context-pack.ts';

/* ─────────────────────────────── context in ────────────────────────────── */

/** A dataset the caller can see, with the columns + measures a metric may reference. */
export type SuggestDataset = {
  id: string;
  name: string;
  /** Tier vocabulary is presentational only — kept tolerant (any string) so an added
   *  kind (e.g. a future "curated") never breaks assembly. */
  tier: string;
  description: string;
  /** Documented columns (name + description) — the ONLY columns a candidate may use. */
  columns: { name: string; description?: string }[];
  /** Existing measures on the dataset (name + aggregation type) — ratio inputs. */
  measures: { name: string; type: string }[];
  /** True once the dataset is a governed Gold asset/product the query engine serves. */
  deliverable: boolean;
};

/** A strategic pillar the caller can view (grounds a candidate's `pillarId`). */
export type SuggestPillar = { id: string; name: string; description: string };

/** A business process (a governed Workflow) the caller can view — grounds `processId`.
 *  `hardRules` are the workflow's HARD (enforced) rules, verbatim; `steps` are the
 *  step titles + actors, so a candidate can be tied to a real process step. */
export type SuggestWorkflow = {
  id: string;
  title: string;
  steps: { title: string; actor: string }[];
  hardRules: string[];
  actors: string[];
};

/** One Operating-Model section the caller can view (7 canonical OM sections). */
export type SuggestOmSection = { id: string; title: string; content: string };

/** The full, ALREADY-GOVERNED context the server assembles under the caller. */
export type SuggestContext = {
  goal?: string;
  pillars: SuggestPillar[];
  omSections: SuggestOmSection[];
  workflows: SuggestWorkflow[];
  datasets: SuggestDataset[];
};

/* ───────────────────────────── candidate out ───────────────────────────── */

/** A cross-entity flag: the metric's inputs span datasets, so the honest answer is to
 *  build a CURATED dataset in Data (a governed join) — NEVER an invented join here. */
export type CrossEntity = { note: string; datasets: string[] };

/**
 * ONE proposed metric. `form` is the exact {@link MetricForm} the builder pre-fills
 * (so one click lands on Refine). `pillarId` / `processId` are grounding handles that
 * MUST resolve to a real, visible pillar / workflow or they are dropped (never faked).
 */
export type Candidate = {
  name: string;
  description: string;
  /** One-line rationale ("why this metric matters", tied to the grounding). */
  why: string;
  /** A real, visible pillar id, or omitted. */
  pillarId?: string;
  /** A real, visible workflow (business-process) id, or omitted. */
  processId?: string;
  /** A dataset the caller can see (else the candidate is dropped). */
  datasetId: string;
  /** The pre-fillable measure form (columns validated against the real dataset). */
  form: MetricForm;
  /** Set when inputs span datasets — points at a curated-dataset build, never a join. */
  crossEntity?: CrossEntity;
};

/** Honest counts of what actually grounded the suggestions (drives the UI banner). */
export type Grounding = { pillars: number; omSections: number; workflows: number; datasets: number };

export type SuggestResult = { candidates: Candidate[]; grounding: Grounding };

export class SuggestError extends Error {
  status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'SuggestError';
  }
}

/* ──────────────────────────────── prompt ───────────────────────────────── */

/** Rough token budget for the assembled context block (reasoning model, generous). */
const CONTEXT_BUDGET = 6000;

/** Trim a list of rendered blocks to fit `budget` tokens, lowest-priority last. */
function trimToBudget(blocks: string[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const b of blocks) {
    const t = estimateTokens(b);
    if (used + t > budget) break;
    kept.push(b);
    used += t;
  }
  return kept;
}

function renderPillars(pillars: SuggestPillar[]): string {
  if (pillars.length === 0) return '';
  const lines = pillars.map((p) => `- [${p.id}] ${p.name}: ${p.description}`.trim());
  return `STRATEGIC PILLARS (a candidate SHOULD serve one — cite its id as pillarId):\n${lines.join('\n')}`;
}

function renderOm(sections: SuggestOmSection[]): string {
  if (sections.length === 0) return '';
  const lines = sections.map((s) => `### ${s.title}\n${s.content}`.trim());
  return `OPERATING MODEL (how the business runs — ground metrics in it):\n${lines.join('\n\n')}`;
}

function renderWorkflows(workflows: SuggestWorkflow[]): string {
  if (workflows.length === 0) return '';
  const lines = workflows.map((w) => {
    const steps = w.steps.map((s) => `${s.title} (${s.actor})`).join(' → ');
    const rules = w.hardRules.length ? `\n  HARD RULES: ${w.hardRules.join('; ')}` : '';
    return `- [${w.id}] ${w.title}\n  STEPS: ${steps || '(none)'}${rules}`;
  });
  return `BUSINESS PROCESSES (governed workflows — cite one as processId when a metric measures a step):\n${lines.join('\n')}`;
}

function renderDatasets(datasets: SuggestDataset[]): string {
  if (datasets.length === 0) return '';
  const lines = datasets.map((d) => {
    const cols = d.columns.map((c) => c.name).join(', ') || '(none documented)';
    const ms = d.measures.map((m) => `${m.name}(${m.type})`).join(', ');
    const badge = d.deliverable ? 'Gold ✓ deliverable' : 'not yet Gold — define but not served';
    return [
      `- [${d.id}] "${d.name}" · ${d.tier} · ${badge}`,
      `  columns: ${cols}`,
      ms ? `  measures: ${ms}` : '',
      d.description ? `  about: ${d.description}` : '',
    ].filter(Boolean).join('\n');
  });
  return `VISIBLE DATASETS (a candidate's datasetId + every column MUST come from here — never invent):\n${lines.join('\n')}`;
}

/**
 * Build the two-message prompt. The system message pins the rules (narrowest-dataset,
 * no invented columns/joins, cross-entity → curated dataset); the user message carries
 * the token-budgeted context. Deterministic + offline-testable.
 */
export function suggestMetricsMessages(ctx: SuggestContext): AssistantMessage[] {
  const system = [
    'You are the Metric-Suggestion agent for the Sovereign Agentic OS semantic layer.',
    "Given a business's strategy, operating model, processes and the datasets the user can",
    'see, propose 3 to 6 HIGH-VALUE candidate metrics that a business leader would track.',
    '',
    'HARD RULES:',
    '• Every candidate MUST name a `datasetId` from the VISIBLE DATASETS list, and every',
    '  column it references MUST be a real column of THAT dataset. Never invent a dataset,',
    '  a column, or a measure.',
    '• NARROWEST DATASET: choose the single dataset that most directly holds the number.',
    '  Do not pick a broad dataset when a focused one has the exact column.',
    '• CROSS-ENTITY: if a metric truly needs columns from MORE THAN ONE dataset, DO NOT',
    '  invent a join. Instead pick the primary datasetId, propose the best single-dataset',
    '  form you can, and set `crossEntity` = {note, datasets:[ids needed]} so the user knows',
    '  to build a curated (joined) dataset in Data first.',
    '• Ground each candidate: set `pillarId` to a real pillar id when it serves one, and',
    '  `processId` to a real workflow id when it measures a process step. Omit if none fits.',
    `• Allowed aggregations: ${MEASURE_TYPES.join(', ')}. For "count" leave column empty; for`,
    '  sum/avg/min/max/count_distinct* pick exactly one real numeric column; for "number"',
    '  (a ratio) set form.aggregation="number" and reference two existing measures in why.',
    '',
    'Respond with STRICT JSON ONLY (no prose, no code fences):',
    '{"candidates":[{"name":"<human name>","description":"<one sentence>","why":"<one line>",',
    '"pillarId":"<id or omit>","processId":"<id or omit>","datasetId":"<id>",',
    '"form":{"name":"<name>","aggregation":"<allowed>","column":"<column or empty>","dimensions":["<column>",...]},',
    '"crossEntity":{"note":"<why a curated dataset is needed>","datasets":["<id>",...]}}]}',
  ].join('\n');

  const contextBlocks = trimToBudget(
    [
      renderPillars(ctx.pillars),
      renderOm(ctx.omSections),
      renderWorkflows(ctx.workflows),
      renderDatasets(ctx.datasets),
    ].filter(Boolean),
    CONTEXT_BUDGET,
  );

  const user = [
    ctx.goal ? `The user's goal: ${ctx.goal}` : 'The user has not stated a specific goal — propose the metrics this business most needs.',
    '',
    contextBlocks.join('\n\n') || '(no strategy or datasets are visible yet)',
    '',
    'Produce the JSON now.',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/* ─────────────────────────────── validator ─────────────────────────────── */

function isMeasureType(t: string): t is MeasureType {
  return (MEASURE_TYPES as readonly string[]).includes(t);
}

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim());
      if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

/** The honest grounding counts of the assembled context (what actually informed the ask). */
export function groundingOf(ctx: SuggestContext): Grounding {
  return {
    pillars: ctx.pillars.length,
    omSections: ctx.omSections.length,
    workflows: ctx.workflows.length,
    datasets: ctx.datasets.length,
  };
}

/**
 * Parse + VALIDATE the model's JSON into real candidates against the REAL context.
 * Server-side mirror of {@link ./agent.ts parseMetricProposal}: a candidate is DROPPED
 * (never trusted) when its dataset isn't visible or its column isn't real; pillar /
 * process ids that don't resolve are cleared (not faked); a cross-entity note keeps
 * only the visible datasets it names. An unparseable response is an honest error.
 */
export function parseCandidates(raw: string, ctx: SuggestContext): SuggestResult {
  const obj = extractJson(raw);
  if (!obj) throw new SuggestError('The suggestion agent did not return usable candidates — try again.');
  const list = Array.isArray(obj.candidates) ? obj.candidates : [];

  const byDataset = new Map(ctx.datasets.map((d) => [d.id, d]));
  const pillarIds = new Set(ctx.pillars.map((p) => p.id));
  const workflowIds = new Set(ctx.workflows.map((w) => w.id));
  const datasetIds = new Set(ctx.datasets.map((d) => d.id));

  const candidates: Candidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const datasetId = String(c.datasetId ?? '').trim();
    const dataset = byDataset.get(datasetId);
    if (!dataset) continue; // invisible / invented dataset → drop

    const rawForm = (c.form && typeof c.form === 'object' ? c.form : {}) as Record<string, unknown>;
    const allowedCols = new Set(dataset.columns.map((col) => col.name));

    const aggregation: MeasureType = isMeasureType(String(rawForm.aggregation)) ? (rawForm.aggregation as MeasureType) : 'count';
    const rawColumn = String(rawForm.column ?? '').trim();
    // count/number carry no base column; every other aggregation needs a REAL column.
    const needsColumn = aggregation !== 'count' && aggregation !== 'number';
    const column = needsColumn ? (allowedCols.has(rawColumn) ? rawColumn : '') : '';
    if (needsColumn && !column) continue; // fabricated / missing column → drop

    const dimensions = Array.isArray(rawForm.dimensions)
      ? [...new Set((rawForm.dimensions as unknown[]).map((d) => String(d).trim()).filter((d) => allowedCols.has(d) && d !== column))]
      : [];

    const name = String(c.name ?? rawForm.name ?? '').trim();
    if (!name) continue; // an unnamed candidate isn't usable → drop

    const form: MetricForm = { name, aggregation, column, dimensions };

    const cand: Candidate = {
      name,
      description: String(c.description ?? '').trim(),
      why: String(c.why ?? '').trim(),
      datasetId,
      form,
    };

    const pillarId = String(c.pillarId ?? '').trim();
    if (pillarId && pillarIds.has(pillarId)) cand.pillarId = pillarId;
    const processId = String(c.processId ?? '').trim();
    if (processId && workflowIds.has(processId)) cand.processId = processId;

    const ce = c.crossEntity as Record<string, unknown> | undefined;
    if (ce && typeof ce === 'object') {
      const dsList = Array.isArray(ce.datasets)
        ? [...new Set((ce.datasets as unknown[]).map((x) => String(x).trim()).filter((x) => datasetIds.has(x)))]
        : [];
      const note = String(ce.note ?? '').trim();
      if (note && dsList.length > 0) cand.crossEntity = { note, datasets: dsList };
    }

    candidates.push(cand);
  }

  return { candidates, grounding: groundingOf(ctx) };
}
