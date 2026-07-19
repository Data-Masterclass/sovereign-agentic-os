/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { assistantComplete } from '@/lib/assistant/complete';

export const dynamic = 'force-dynamic';

/**
 * The per-STAGE Metrics assistant — one governed helper, scoped to the guided stage
 * the user is on (Define · Refine · Preview · Publish · Monitor). Reuses the same
 * `assistantComplete` transport every other built-in helper uses (Langfuse-audited,
 * cost-cap enforced). Honest 503 (no model) and 402 (cost cap) — no fake-AI fallback.
 *
 * Define returns `{ form }` — a partial form payload the client drops into the guided
 * fields. Every other stage returns `{ text }` (plain prose).
 */

type Stage = 'define' | 'refine' | 'preview' | 'publish' | 'monitor';
const STAGES = new Set<Stage>(['define', 'refine', 'preview', 'publish', 'monitor']);

function promptFor(
  stage: Stage,
  body: Record<string, unknown>,
): { system: string; user: string; json: boolean } {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const goal = s(body.goal);
  const columns = Array.isArray(body.columns)
    ? body.columns.filter((c): c is string => typeof c === 'string')
    : [];
  const aggregation = s(body.aggregation);
  const errorMsg = s(body.error);
  const metricName = s(body.metricName);
  const tier = s(body.tier);
  const historyHint = s(body.historyHint);

  switch (stage) {
    case 'define':
      return {
        json: true,
        system:
          'You help a business user define a governed metric on a data table. Given their goal and the table\'s real columns, propose ONE metric as a JSON object: {"name": string, "aggregation": one of "count"|"count_distinct"|"sum"|"avg"|"min"|"max", "column": string or "", "dimensions": string[]}. Use ONLY columns from the provided list. For count, column is "". Be concise — no prose, just the JSON object.',
        user: `Goal: ${goal || '(none given)'}\nAvailable columns: ${columns.join(', ') || '(none)'}\nReturn the JSON metric definition.`,
      };
    case 'refine':
      return {
        json: false,
        system:
          'You suggest how to refine a business metric in plain language: which dimensions to slice by, what filters add value, and whether a time window makes sense. Two or three short sentences. Reference the available columns by name.',
        user: `Metric: "${metricName || '(unnamed)'}" using ${aggregation || 'an aggregation'}\nAvailable columns: ${columns.join(', ') || '(none)'}\nSuggest dimensions, filters and time window.`,
      };
    case 'preview':
      return {
        json: false,
        system:
          'You explain a Cube query error or pending state to a non-technical user in two or three plain sentences: what likely caused it and the single most useful next step. No SQL jargon; speak to what the user should do, not to Cube internals.',
        user: `The metric preview returned: "${errorMsg || '(no error — metric is syncing or live)'}". Explain what is happening and what to try.`,
      };
    case 'publish':
      return {
        json: false,
        system:
          'You draft a short, honest promotion justification for a metric moving up a governance tier (Personal → Domain → Company). Two or three sentences: what it measures, who it serves, why it is ready to share. No hype.',
        user: `Metric: "${metricName || '(unnamed)'}", currently ${tier || 'Personal'} tier. Draft a promotion justification.`,
      };
    case 'monitor':
      return {
        json: false,
        system:
          'You suggest a sensible alert threshold for a business metric, given any historical context. One or two sentences: what threshold to start with and why. Be specific and practical.',
        user: `Metric: "${metricName || '(unnamed)'}"${historyHint ? `\nContext: ${historyHint}` : ''}\nSuggest an alert threshold and comparator.`,
      };
  }
}

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST { stage, ... } → a stage-scoped suggestion.
 * Define returns `{ form }` (parsed JSON); every other stage returns `{ text }`.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const stage = body.stage as Stage;
    if (!STAGES.has(stage)) {
      return NextResponse.json(
        { error: 'A valid stage is required (define|refine|preview|publish|monitor).' },
        { status: 400 },
      );
    }

    const { system, user: userMsg, json } = promptFor(stage, body);
    const { content } = await assistantComplete(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      { user: { id: user.id, domains: user.domains } },
    );

    if (!json) return NextResponse.json({ text: content });

    // Define: parse the model's JSON form object defensively.
    const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let form: unknown;
    try {
      form = JSON.parse(cleaned);
    } catch {
      form = null;
    }
    if (!form || typeof form !== 'object' || Array.isArray(form)) {
      return NextResponse.json(
        { error: 'The assistant did not return a usable metric definition — try rephrasing.' },
        { status: 502 },
      );
    }
    return NextResponse.json({ form });
  } catch (e) {
    return fail(e);
  }
}
