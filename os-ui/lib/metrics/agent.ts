/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The Metric AGENT (pure core).
 *
 * Turns a natural-language goal + the dataset's REAL columns into a STRUCTURED
 * metric proposal (aggregation + column + dimensions) — the same {@link MetricForm}
 * the friendly form writes, so agent and form converge on one artifact. The LLM
 * call is made by the route through the ONE governed assistant helper; this module
 * only builds the prompt and validates the model's JSON against the real schema, so
 * it is transport-free and unit-testable offline.
 */
import { MEASURE_TYPES, type MeasureType } from '../data/metrics.ts';
import type { MetricForm } from './model.ts';
import type { AssistantMessage } from '../assistant/complete.ts';

/** Prompt the assistant to propose a metric grounded in the dataset's columns. */
export function metricAgentMessages(columns: string[], goal: string): AssistantMessage[] {
  const system = [
    'You are the Metric Agent for the Sovereign Agentic OS semantic layer. Given a',
    "dataset's real columns and a business goal, propose ONE measure the platform can",
    'build in Cube. You may ONLY use the listed columns — never invent a name.',
    '',
    `Allowed aggregations: ${MEASURE_TYPES.join(', ')}.`,
    'Rules: for "count" leave column empty; for every other aggregation pick exactly',
    'one numeric column to aggregate. Dimensions are columns the metric can be sliced',
    'by (e.g. a date or a category) — choose 0–3 from the columns.',
    '',
    'Respond with STRICT JSON ONLY (no prose, no code fences):',
    '{"name":"<human name>","aggregation":"<one of the allowed>","column":"<column or empty>","dimensions":["<column>",...]}',
  ].join('\n');
  const user = [
    `Columns: ${columns.length ? columns.join(', ') : '(none documented)'}`,
    `Goal: ${goal}`,
    'Produce the JSON proposal now.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
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

function isMeasureType(t: string): t is MeasureType {
  return (MEASURE_TYPES as readonly string[]).includes(t);
}

export class MetricAgentError extends Error {
  status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'MetricAgentError';
  }
}

/**
 * Parse + VALIDATE the model's JSON into a MetricForm against the dataset's real
 * columns. A column the dataset does not have is dropped (never trusted); an
 * unparseable / unusable response is an honest error, not a fabricated metric.
 */
export function parseMetricProposal(raw: string, columns: string[], goal = ''): MetricForm {
  const obj = extractJson(raw);
  if (!obj) throw new MetricAgentError('The metric agent did not return a usable proposal — try rephrasing the goal.');
  const allowed = new Set(columns);

  const aggregation: MeasureType = isMeasureType(String(obj.aggregation)) ? (obj.aggregation as MeasureType) : 'count';

  const rawColumn = String(obj.column ?? '').trim();
  const column = aggregation === 'count' ? '' : allowed.has(rawColumn) ? rawColumn : '';
  if (aggregation !== 'count' && !column) {
    throw new MetricAgentError(`The agent proposed a ${aggregation} but no valid column from the dataset — pick one in the form.`);
  }

  const dimensions = Array.isArray(obj.dimensions)
    ? [...new Set((obj.dimensions as unknown[]).map((d) => String(d).trim()).filter((d) => allowed.has(d) && d !== column))]
    : [];

  const name = String(obj.name ?? '').trim() || goal.trim().slice(0, 60) || 'Metric';
  return { name, aggregation, column, dimensions };
}
