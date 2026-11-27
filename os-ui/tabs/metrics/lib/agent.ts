/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Metric agent core — prompt and validation for a natural-language metric proposal
 * USER STORY: As a creator I want to describe a business goal and get a metric proposal built only from
 *             my dataset's real columns, so that the agent and the form produce the same metric.
 * ARCHITECTURE:
 *   - Pure and transport-free: builds the system/user messages and parses the model's JSON into a
 *     `MetricForm`. The LLM call itself is made by `app/api/metrics/agent/route.ts`.
 *   - Columns the dataset does not have are dropped; an unusable reply throws `MetricAgentError` (502)
 *     instead of producing a guessed metric.
 */
import { MEASURE_TYPES, type MeasureType } from '@tabs/data/lib/index';
import type { MetricForm } from '@tabs/metrics/lib/model';
import type { AssistantMessage } from '@core/runtime/complete';
import { withAnswerLanguage } from '@core/i18n/answer-language';
import type { Locale } from '@core/i18n/config';

/**
 * Prompt the assistant to propose a metric grounded in the dataset's columns.
 * `locale` (the requesting user's language) makes the proposed human name come back in that language; English
 * leaves the prompt byte-for-byte unchanged. Column names and the JSON keys stay as they are.
 */
export function metricAgentMessages(columns: string[], goal: string, locale?: Locale | string | null): AssistantMessage[] {
  const system = [
    'You are the Metric Agent for the Sovereign Agentic OS semantic layer. Given a',
    "dataset's real columns and a business goal, propose ONE measure the platform can",
    'build as a dbt metric on this dataset. You may ONLY use the listed columns — never invent a name.',
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
  const messages = withAnswerLanguage<AssistantMessage>([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], locale, 'generated');
  if (messages[0].content === system) return messages; // English: byte-for-byte unchanged
  // Another language: the name becomes the FROZEN measure identifier (slug() keeps only a–z/0–9), so it must be
  // plain ASCII; the aggregation is a machine keyword and is never translated. parseMetricProposal enforces both.
  return messages.map((m, i) => (i === 0 ? { ...m, content: [
    m.content,
    'The "name" must use plain ASCII letters, digits and spaces only (write accented letters without accents) — it becomes the metric\'s permanent identifier.',
    `The "aggregation" value is a fixed keyword: exactly one of ${MEASURE_TYPES.join(', ')} — never translate it.`,
  ].join('\n') } : m));
}

/**
 * Agent-proposed names only: fold accented letters to ASCII ("Průměrná tržba" → "Prumerna trzba") so slug() makes
 * `prumerna_trzba` instead of `pr_m_rn_tr_ba`. slug() itself is unchanged, so every existing name keeps its id.
 */
const ASCII_FOLD: Record<string, string> = { ł: 'l', Ł: 'L', ß: 'ss', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE' };
export function asciiFoldName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[łŁßøØđĐæÆœŒ]/g, (c) => ASCII_FOLD[c])
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

  // The aggregation is a fixed machine keyword in every language: tolerate case/spacing, refuse anything else
  // rather than silently turning an unknown (e.g. translated) value into a count.
  const rawAggregation = String(obj.aggregation ?? '').trim().toLowerCase();
  if (!isMeasureType(rawAggregation)) {
    throw new MetricAgentError(
      `The agent proposed an unknown aggregation "${String(obj.aggregation ?? '')}" (allowed: ${MEASURE_TYPES.join(', ')}) — pick one in the form or try again.`,
    );
  }
  const aggregation: MeasureType = rawAggregation;

  const rawColumn = String(obj.column ?? '').trim();
  const column = aggregation === 'count' ? '' : allowed.has(rawColumn) ? rawColumn : '';
  if (aggregation !== 'count' && !column) {
    throw new MetricAgentError(`The agent proposed a ${aggregation} but no valid column from the dataset — pick one in the form.`);
  }

  const dimensions = Array.isArray(obj.dimensions)
    ? [...new Set((obj.dimensions as unknown[]).map((d) => String(d).trim()).filter((d) => allowed.has(d) && d !== column))]
    : [];

  const name = asciiFoldName(String(obj.name ?? '')) || asciiFoldName(goal).slice(0, 60) || 'Metric';
  return { name, aggregation, column, dimensions };
}
