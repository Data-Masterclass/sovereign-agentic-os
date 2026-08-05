/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser, type CurrentUser } from '@/lib/core/auth';
import { failResponse } from '@/lib/assistant/stage-route';
import { parseJsonReply } from '@/lib/assistant/json-reply';
import { assistantComplete } from '@/lib/assistant/complete';
import { roleModel } from '@/lib/models/roles';
import {
  getModel,
  visibleDatasets,
  datasetColumns,
  validateDefinition,
  type RawDefinition,
} from '@/lib/science';

export const dynamic = 'force-dynamic';

/**
 * The Science assistant — ONE persistent, governed, MULTI-TURN chat scoped to the guided stage
 * (Design · Launch · Monitor). It runs the SAME ONE assistant model every built-in helper uses
 * (`assistantComplete`: Langfuse-audited, cost-cap enforced), inheriting the honest 503 (no
 * model) / 402 (cost cap) errors — no fake-AI fallback. It only SUGGESTS; every mutation runs
 * through the governed create / train / predict routes on an explicit user Apply.
 *
 * Grounding (per turn): the model's real state (spec, buildState, real metric, last errors,
 * usage), the caller's VISIBLE datasets + the selected dataset's REAL columns, and the honest
 * capability statement. A Design suggestion naming a dataset/column is VALIDATED server-side
 * against that feed (`validateDefinition`) — a hallucinated dataset/column is refused and no
 * Apply card is returned (only the prose stands).
 *
 * Response:
 *   • design  → { message, suggestions: { definition? } }   (definition present ⇒ validated)
 *   • launch  → { message, suggestions: { launch? } }        (action card)
 *   • monitor → { message, suggestions: { scoreExample? } }  (action card)
 */

type Stage = 'design' | 'launch' | 'monitor';
const STAGES = new Set<Stage>(['design', 'launch', 'monitor']);

const CAPABILITY =
  'This runtime trains classification and regression models on CPU; algorithms are chosen automatically. It does NOT do forecasting or clustering — never suggest them.';

type Turn = { role: 'user' | 'assistant'; content: string };

/** Coerce the request `messages` into a clean, bounded turn list. */
function readTurns(body: Record<string, unknown>): Turn[] {
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const turns: Turn[] = [];
  for (const m of raw.slice(-12)) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as Record<string, unknown>).role;
    const content = (m as Record<string, unknown>).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      turns.push({ role, content: content.slice(0, 4000) });
    }
  }
  return turns;
}

/** A compact digest of the model's real state for grounding (empty when no model yet). */
function modelDigest(m: ReturnType<typeof getModel>): string {
  if (!m) return '(no model yet — the user is still designing it)';
  const lines = [`Model "${m.name}" [${m.buildState ?? 'draft'}]`];
  if (m.spec) lines.push(`Task: ${m.spec.taskType}; source: ${m.spec.sourceDataProductFqn}; target: ${m.spec.targetColumn ?? '(none)'}; features: ${m.spec.features.join(', ') || '(none)'}`);
  if (typeof m.metrics?.primary === 'number') lines.push(`Trained metric: ${m.metrics.primaryMetric ?? m.spec?.optimizeMetric ?? 'metric'} ${m.metrics.primary}`);
  if (m.lastTrainingError) lines.push(`Last training error: ${m.lastTrainingError}`);
  if (m.lastDeployError) lines.push(`Last deploy error: ${m.lastDeployError}`);
  if (m.usage) lines.push(`Usage: ${m.usage.count} calls (${m.usage.denied} denied)${m.usage.lastCalledAt ? `, last ${m.usage.lastCalledAt}` : ''}`);
  return lines.join('\n');
}

/** The stage-scoped system prompt. Design demands strict JSON with a definition. */
function systemFor(stage: Stage): string {
  switch (stage) {
    case 'design':
      return [
        'You are the Design-stage assistant for a business user defining a supervised ML model over their governed data.',
        CAPABILITY,
        'You NEVER mutate anything — you only suggest; the user clicks Apply to create the draft.',
        'When (and only when) you have enough to propose a concrete model, respond with STRICT JSON (no prose outside it, no code fences):',
        '{ "message": string (markdown; a short, friendly explanation of what you propose and why),',
        '  "definition"?: { "datasetId": exact id from the "Your datasets" list, "targetColumn": one of the dataset\'s real columns to predict, "features": array of 2-8 OTHER real columns, "taskType": one of binary_classification|multiclass_classification|regression, "rationale": one short sentence } }',
        'Use ONLY a datasetId from the provided list and ONLY column names from the provided columns — never invent a dataset or a column. If you are missing the dataset or columns, ask a clarifying question in "message" and omit "definition".',
      ].join('\n');
    case 'launch':
      return [
        'You are the Launch-stage assistant. The user has a defined model and wants to train it and put it live (one fused "Train & launch" step).',
        CAPABILITY,
        'You NEVER mutate anything — you only suggest; the user clicks Apply to start.',
        'Respond with STRICT JSON (no prose outside it, no code fences):',
        '{ "message": string (markdown; explain what launching does, or interpret a failure plainly and suggest one next step),',
        '  "launch"?: true (include ONLY when the user is ready and asking to start training) }',
      ].join('\n');
    case 'monitor':
      return [
        'You are the Monitor-stage assistant for a DEPLOYED model. You interpret its health, its real usage, and individual prediction scores for a business user — honestly (a score is a probability, not a certainty). If there is no usage yet, say so plainly.',
        CAPABILITY,
        'You NEVER mutate anything — you only suggest.',
        'Respond with STRICT JSON (no prose outside it, no code fences):',
        '{ "message": string (markdown; your interpretation),',
        '  "scoreExample"?: true (include when suggesting the user try the model on a real example row) }',
      ].join('\n');
  }
}

/** Build the grounding context turn prepended to the conversation. */
async function contextBlock(
  stage: Stage,
  m: ReturnType<typeof getModel>,
  user: CurrentUser,
  datasetId: string,
): Promise<string> {
  const parts = [modelDigest(m)];
  if (stage === 'design') {
    const visible = visibleDatasets(user);
    parts.push(
      'Your datasets (id — name [scope]) — reference ONLY these by exact id:',
      visible.length ? visible.map((d) => `${d.id} — ${d.name} [${d.scope}]`).join('\n') : '(you have no datasets yet — the user must create or share one in the Data tab first)',
    );
    if (datasetId) {
      const cols = await datasetColumns(datasetId, user);
      parts.push(`Columns of the selected dataset (${datasetId}): ${cols.length ? cols.join(', ') : '(none readable)'}`);
    }
  }
  return parts.join('\n');
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const stage = body.stage as Stage;
    if (!STAGES.has(stage)) {
      return NextResponse.json({ error: 'A valid stage is required (design|launch|monitor).' }, { status: 400 });
    }
    const modelId = typeof body.model === 'string' ? body.model : '';
    const datasetId = typeof body.datasetId === 'string' ? body.datasetId : '';
    const m = modelId ? getModel(modelId) : null;

    const turns = readTurns(body);
    if (turns.length === 0) {
      turns.push({ role: 'user', content: stage === 'design' ? 'Help me design a model from my data.' : stage === 'launch' ? 'Should I launch this now?' : 'How is this model doing?' });
    }

    const messages = [
      { role: 'system' as const, content: systemFor(stage) },
      { role: 'user' as const, content: await contextBlock(stage, m, user, datasetId) },
      ...turns,
    ];

    // Design (structured spec drafting) is reasoning-heavy → reasoning tier; the lighter
    // Launch/Monitor helpers stay on the default assistant model.
    const model = stage === 'design' ? roleModel('reasoning') : undefined;
    const { content } = await assistantComplete(messages, { user: { id: user.id, domains: user.domains }, model });

    const parsed = parseJsonReply(content);
    const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    const message = (obj && typeof obj.message === 'string' && obj.message) || content || 'The assistant did not return a usable result — try rephrasing.';

    if (stage === 'design') {
      const rawDef = obj && obj.definition && typeof obj.definition === 'object' ? (obj.definition as RawDefinition) : null;
      if (!rawDef) return NextResponse.json({ message, suggestions: {} });
      const validated = await validateDefinition(rawDef, user);
      if ('error' in validated) {
        // Refuse-with-reason: the model hallucinated a dataset/column — no Apply card, honest note.
        return NextResponse.json({
          message: `${message}\n\n_I can’t offer that as a one-click apply — it ${validated.error}. Pick a dataset above and I’ll suggest real columns._`,
          suggestions: {},
        });
      }
      return NextResponse.json({ message, suggestions: { definition: validated.definition } });
    }

    if (stage === 'launch') {
      const launch = obj?.launch === true && (m?.buildState === 'draft' || m?.buildState === 'trained' || m?.buildState === 'deploy_failed');
      return NextResponse.json({ message, suggestions: launch ? { launch: true } : {} });
    }

    // monitor
    const scoreExample = obj?.scoreExample === true && m?.buildState === 'deployed';
    return NextResponse.json({ message, suggestions: scoreExample ? { scoreExample: true } : {} });
  } catch (e) {
    return failResponse(e);
  }
}
