/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { failResponse, runStageAssistant } from '@/lib/assistant/stage-route';

export const dynamic = 'force-dynamic';

/**
 * The per-STAGE Data assistant — one governed helper, scoped to the guided stage the user
 * is on (Define · Ingest · Refine · Publish · Use). It runs the SAME ONE assistant model
 * every other built-in helper uses (`assistantComplete`: Langfuse-audited, cost-cap enforced),
 * so it inherits the honest 503 (no model configured) and 402 (cost cap) errors — there is
 * NO fake-AI fallback. The model only SUGGESTS text/JSON; it never mutates a dataset. The
 * client applies suggestions through the normal docs/build/promote paths.
 *
 * The response is always `{ text }` (plain prose) except Define, which asks for a strict JSON
 * `{ description, columns, checks }` draft the client can drop into the Define stage.
 * (Use has no assistant — Talk to Data is its own governed NL→SQL surface.)
 */

type Stage = 'define' | 'ingest' | 'refine' | 'publish';
const STAGES = new Set<Stage>(['define', 'ingest', 'refine', 'publish']);

/** Build the stage-scoped system + user prompt pair from the request body. */
function promptFor(stage: Stage, body: Record<string, unknown>): { system: string; user: string; json: boolean } {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const name = s(body.name);
  const prompt = s(body.prompt);
  const columns = Array.isArray(body.columns) ? body.columns.filter((c): c is string => typeof c === 'string') : [];
  const reason = s(body.reason);
  const measures = Array.isArray(body.measures) ? body.measures.filter((m): m is string => typeof m === 'string') : [];

  switch (stage) {
    case 'define':
      return {
        json: true,
        system:
          'You help a business user document a new dataset. Given its name and the list of its column names, draft (1) a one-line plain-language description, (2) a short meaning for each column, and (3) a few sensible data-quality rules. Return ONLY a JSON object (no prose, no code fences): {"description": string, "columns": [{"name": string, "description": string}], "checks": [{"rule": one of "not_null"|"not_blank"|"unique"|"accepted_values"|"range", "column": string, "values"?: string[], "min"?: number, "max"?: number}]}. Use only the provided column names. Prefer not_null on identifiers, unique on a primary key, range on obvious numeric bounds. 3-6 checks.',
        user: `Dataset: ${name || '(unnamed)'}\nColumns: ${columns.join(', ') || '(none documented yet)'}\nWhat it is (optional): ${prompt}\nReturn the JSON draft.`,
      };
    case 'ingest':
      return {
        json: false,
        system:
          'You explain a data-ingest failure to a non-technical user in plain language: what likely went wrong bringing the raw file/extract into the Bronze layer, and the single most useful next step. Two or three sentences. No jargon dumps.',
        user: `The Bronze ingest reported this failure: "${reason || '(no reason given)'}". Explain it plainly and suggest what to try.`,
      };
    case 'refine':
      return {
        json: false,
        system:
          'You advise a user on how to clean and join this dataset into a trustworthy Silver/Gold table. Given its columns, propose in plain language: which columns likely need cleaning (types, nulls, casing), and one sensible join if the columns hint at a key. If a CTAS/transform error is provided, explain it plainly instead. Keep it to a short paragraph plus a few bullets.',
        user: `Dataset: ${name || '(unnamed)'}\nColumns: ${columns.join(', ') || '(none)'}\nTransform error (optional): "${reason}"\nAdvise how to clean/join it${reason ? ', and explain the error' : ''}.`,
      };
    case 'publish':
      return {
        json: false,
        system:
          'You suggest governed BI measures to define on a refined (Gold) dataset before it is promoted or certified. Given its columns and any measures already defined, propose 3-5 useful aggregate measures (count, sum, average, distinct-count) in plain language, naming the column each reads. One short paragraph plus a bullet list. Use only the provided columns.',
        user: `Dataset: ${name || '(unnamed)'}\nColumns: ${columns.join(', ') || '(none)'}\nMeasures already defined: ${measures.join(', ') || '(none)'}\nSuggest measures to define.`,
      };
  }
}

/**
 * POST { stage, ... } → a stage-scoped suggestion. Define returns `{ description, columns,
 * checks }` (parsed from the model's JSON); every other stage returns `{ text }`. The route
 * runs AS the signed-in user (identity threaded to the audited, cost-capped model), and the
 * `[id]` param scopes the audit trail to this dataset even though the model reads no rows.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    await ctx.params; // scope the request to a specific dataset (audit + future row context)
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const stage = body.stage as Stage;
    if (!STAGES.has(stage)) {
      return NextResponse.json({ error: 'A valid stage is required (define|ingest|refine|publish).' }, { status: 400 });
    }

    return await runStageAssistant({
      prompt: promptFor(stage, body),
      user,
      jsonKey: 'draft',
      jsonError: 'The assistant did not return a usable draft — try rephrasing.',
    });
  } catch (e) {
    return failResponse(e);
  }
}
