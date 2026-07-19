/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { failResponse, runStageAssistant } from '@/lib/assistant/stage-route';

export const dynamic = 'force-dynamic';

/**
 * The per-STAGE Science assistant — one governed helper, scoped to the guided stage the
 * user is on (Define · Train · Deploy · Predict · Monitor). It runs the SAME ONE assistant
 * model every other built-in helper uses (`assistantComplete`: Langfuse-audited, cost-cap
 * enforced), so it inherits the honest 503 (no model configured) and 402 (cost cap) errors
 * — there is NO fake-AI fallback. The model only SUGGESTS; it never mutates a model. The
 * client applies suggestions through the normal create / train / deploy path.
 *
 * Replaces the dead /api/science/agent plan-proposal orphan.
 *
 * Every stage returns `{ text }` (plain prose) except Define, which asks for a strict JSON
 * object the client can drop into the Define form: { taskType, targetColumn, features }.
 */

type Stage = 'define' | 'train' | 'deploy' | 'predict' | 'monitor';
const STAGES = new Set<Stage>(['define', 'train', 'deploy', 'predict', 'monitor']);

const TRAINABLE = 'binary_classification | multiclass_classification | regression';

/** Build the stage-scoped system + user prompt pair from the request body. */
function promptFor(stage: Stage, body: Record<string, unknown>): { system: string; user: string; json: boolean } {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const prompt = s(body.prompt);
  const columns = Array.isArray(body.columns) ? body.columns.filter((c): c is string => typeof c === 'string') : [];
  const reason = s(body.reason);
  const score = typeof body.score === 'number' ? body.score : undefined;
  const band = s(body.band);
  const metric = s(body.metric);
  const drift = s(body.drift);

  switch (stage) {
    case 'define':
      return {
        json: true,
        system:
          `You help a business user define a supervised ML model over a governed dataset. This runtime can ONLY train these task types: ${TRAINABLE} (forecast and clustering are NOT trainable — never suggest them). Given the user's goal and the dataset's REAL column names, return ONLY a JSON object (no prose, no code fences): {"taskType": one of ${TRAINABLE}, "targetColumn": one of the provided columns (the thing to predict), "features": array of 2-8 OTHER provided columns to learn from}. Choose the taskType from the target's apparent nature (a yes/no or churn-like column → binary_classification; a numeric amount → regression). Use ONLY column names from the provided list; never invent one.`,
        user: `Goal: ${prompt || '(none given)'}\nDataset columns: ${columns.join(', ') || '(none provided)'}\nReturn the JSON model definition.`,
      };
    case 'train':
      return {
        json: false,
        system:
          'You explain an ML training failure to a non-technical user in plain language: the single most likely cause and the one most useful next step. Two or three sentences. No stack-trace dumps, no jargon.',
        user: `The training job reported this error: "${reason || '(no error given)'}". Explain it plainly and suggest what to try.`,
      };
    case 'deploy':
      return {
        json: false,
        system:
          'You explain why an ML model could not deploy to its serving endpoint, in plain language for a non-technical user: the likely readiness/rollout problem and the one next step. Two or three sentences.',
        user: `The deploy step reported this: "${reason || '(no reason given)'}". Explain it plainly and suggest what to try.`,
      };
    case 'predict':
      return {
        json: false,
        system:
          'You interpret a single model prediction for a business user: what the score means and, given the risk band, what a reasonable next action is. Two or three sentences. Be honest that a score is a probability/estimate, not a certainty.',
        user: `The model returned score ${score ?? '(none)'}${metric ? ` (${metric})` : ''} in the ${band || 'unknown'} band. Explain what this means and a sensible next step.`,
      };
    case 'monitor':
      return {
        json: false,
        system:
          'You interpret model monitoring signals (headline metric and any drift) for a business user: whether the model still looks healthy and, if drift is present, what it implies. Two or three plain sentences. If no real drift data is given, say plainly that drift telemetry is not yet available and what would need to be in place to monitor it.',
        user: `Headline metric: ${metric || '(none)'}. Drift signal: ${drift || '(no drift telemetry available)'}. Interpret the model's health.`,
      };
  }
}

/**
 * POST { stage, ... } → a stage-scoped suggestion. Define returns `{ definition }`
 * (parsed from the model's JSON object); every other stage returns `{ text }`.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const stage = body.stage as Stage;
    if (!STAGES.has(stage)) {
      return NextResponse.json({ error: 'A valid stage is required (define|train|deploy|predict|monitor).' }, { status: 400 });
    }

    return await runStageAssistant({
      prompt: promptFor(stage, body),
      user,
      jsonKey: 'definition',
      jsonError: 'The assistant did not return a usable model definition — try rephrasing.',
    });
  } catch (e) {
    return failResponse(e);
  }
}
