/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { failResponse, runStageAssistant } from '@/lib/assistant/stage-route';
import { runSuggest } from '@/lib/metrics/suggest-server';

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

type Stage = 'define' | 'refine' | 'preview' | 'publish' | 'monitor' | 'suggest';
const STAGES = new Set<Stage>(['define', 'refine', 'preview', 'publish', 'monitor', 'suggest']);

/** The five per-stage prompt helpers (NOT `suggest`, which assembles context server-side). */
type PromptStage = Exclude<Stage, 'suggest'>;

function promptFor(
  stage: PromptStage,
  body: Record<string, unknown>,
): { system: string; user: string; json: boolean } {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const goal = s(body.goal);
  const columns = Array.isArray(body.columns)
    ? body.columns.filter((c): c is string => typeof c === 'string')
    : [];
  // P0-3: the documented schema the Define proposal should be grounded in.
  const columnDocs = Array.isArray(body.columnDocs)
    ? (body.columnDocs as unknown[])
        .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>) : {}))
        .map((c) => ({ name: s(c.name).trim(), description: s(c.description).trim() }))
        .filter((c) => c.name && c.description)
    : [];
  const datasetDescription = s(body.datasetDescription).trim();
  const measures = Array.isArray(body.measures)
    ? (body.measures as unknown[])
        .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>) : {}))
        .map((m) => ({ name: s(m.name).trim(), type: s(m.type).trim() }))
        .filter((m) => m.name)
    : [];
  const aggregation = s(body.aggregation);
  const errorMsg = s(body.error);
  const metricName = s(body.metricName);
  const tier = s(body.tier);
  const historyHint = s(body.historyHint);

  switch (stage) {
    case 'define': {
      // P0-3: give the model the documented schema (column docs, dataset description,
      // existing measures) so its single proposal is grounded, not just column-name matching.
      const docs = columnDocs.length
        ? `\nColumn docs: ${columnDocs.map((c) => `${c.name} — ${c.description}`).join('; ')}`
        : '';
      const about = datasetDescription ? `\nDataset: ${datasetDescription}` : '';
      const ms = measures.length
        ? `\nExisting measures (reuse names for a ratio, don't redefine): ${measures.map((m) => `${m.name}(${m.type})`).join(', ')}`
        : '';
      return {
        json: true,
        system:
          'You help a business user define a governed metric on a data table. Given their goal, the table\'s real columns (with any documentation) and its dataset description, propose ONE metric as a JSON object: {"name": string, "aggregation": one of "count"|"count_distinct"|"sum"|"avg"|"min"|"max", "column": string or "", "dimensions": string[]}. Use ONLY columns from the provided list; let the column docs and dataset description guide which column and aggregation genuinely answer the goal. For count, column is "". Be concise — no prose, just the JSON object.',
        user: `Goal: ${goal || '(none given)'}\nAvailable columns: ${columns.join(', ') || '(none)'}${docs}${about}${ms}\nReturn the JSON metric definition.`,
      };
    }
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

/**
 * POST { stage, ... } → a stage-scoped suggestion.
 * `suggest` assembles the caller's strategy/OM/process/dataset context and returns
 * `{ candidates, grounding }`; `define` returns `{ form }`; every other stage `{ text }`.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const stage = body.stage as Stage;
    if (!STAGES.has(stage)) {
      return NextResponse.json(
        { error: 'A valid stage is required (define|refine|preview|publish|monitor|suggest).' },
        { status: 400 },
      );
    }

    // The strategy-grounded "suggest metrics" stage: server assembles ALL context
    // under the caller, runs the reasoning model, and validates candidates against the
    // real, visible datasets (drops any fabricated dataset/column).
    if (stage === 'suggest') {
      const goal = typeof body.goal === 'string' ? body.goal : undefined;
      return NextResponse.json(await runSuggest(user, goal));
    }

    return await runStageAssistant({
      prompt: promptFor(stage, body),
      user,
      jsonKey: 'form',
      jsonError: 'The assistant did not return a usable metric definition — try rephrasing.',
    });
  } catch (e) {
    return failResponse(e);
  }
}
