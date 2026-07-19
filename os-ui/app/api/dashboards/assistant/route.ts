/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { failResponse, runStageAssistant } from '@/lib/assistant/stage-route';

export const dynamic = 'force-dynamic';

/**
 * The per-STAGE Dashboards assistant — one governed helper, scoped to the guided stage
 * the user is on (Define · Design · Build · View · Govern). It runs the SAME ONE assistant
 * model every other built-in helper uses (`assistantComplete`: Langfuse-audited, cost-cap
 * enforced), so it inherits the honest 503 (no model configured) and 402 (cost cap) errors
 * — there is NO fake-AI fallback. The model only SUGGESTS text/JSON; it never mutates a
 * dashboard. The client applies suggestions through the normal build path.
 *
 * The response is always `{ text }` (plain prose) except Design, which asks for a strict
 * JSON chart array the client can drop straight into the Design stage.
 */

type Stage = 'define' | 'design' | 'build' | 'view' | 'govern';
const STAGES = new Set<Stage>(['define', 'design', 'build', 'view', 'govern']);

/** Build the stage-scoped system + user prompt pair from the request body. */
function promptFor(stage: Stage, body: Record<string, unknown>): { system: string; user: string; json: boolean } {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const prompt = s(body.prompt);
  const view = s(body.view);
  const members = Array.isArray(body.members) ? body.members.filter((m): m is string => typeof m === 'string') : [];
  const reason = s(body.reason);
  const rls = s(body.rls);
  const name = s(body.name);
  const tier = s(body.tier);

  switch (stage) {
    case 'define':
      return {
        json: false,
        system:
          'You help a business user start a dashboard on governed BI metrics. Given their goal and the list of available Cube views, recommend ONE view to bind the dashboard to and 3-4 starter charts to draw from it. Be concise: one short paragraph, then a bullet list of the starter charts. Do not invent view or member names not in the provided list.',
        user: `Goal: ${prompt || '(none given)'}\nAvailable Cube views: ${members.join(', ') || '(none)'}\nSuggest one view and starter charts.`,
      };
    case 'design':
      return {
        json: true,
        system:
          'You design dashboard chart tiles over a SINGLE governed Cube view. Return ONLY a JSON array (no prose, no code fences) of chart objects: {"name": string, "vizType": one of "big_number_total"|"line"|"bar"|"table", "metric": one of the provided member ids}. Prefer a big_number_total per key measure, a line trend for the primary measure, and a bar or table top-N. Use only members from the provided list. 3-6 charts.',
        user: `Cube view: ${view || '(unknown)'}\nAvailable members: ${members.join(', ') || '(none)'}\nGoal (optional): ${prompt}\nReturn the JSON chart array.`,
      };
    case 'build':
      return {
        json: false,
        system:
          'You explain a dashboard build/import failure to a non-technical user in plain language: what likely went wrong, and the single most useful next step. Two or three sentences. No jargon dumps.',
        user: `The dashboard build reported this failure reason: "${reason || '(no reason given)'}". Explain it plainly and suggest what to try.`,
      };
    case 'view':
      return {
        json: false,
        system:
          'You explain, in one or two plain sentences, what a row-level-security (RLS) clause filters — which rows a viewer will and will not see through it. No SQL lecture; speak to the business meaning.',
        user: `The viewer is seeing this dashboard under RLS: ${rls || '(unfiltered — the viewer sees every row)'}. Explain what it filters.`,
      };
    case 'govern':
      return {
        json: false,
        system:
          'You draft a short, honest promotion justification for a dashboard moving up a governance tier (Personal → Domain → Company). 2-3 sentences: what it shows, who it serves, why it is ready to share. No hype.',
        user: `Dashboard: ${name || '(unnamed)'} on Cube view ${view || '(unknown)'}, currently ${tier || 'Personal'} tier. Draft a promotion justification.`,
      };
  }
}

/**
 * POST { stage, ... } → a stage-scoped suggestion. Design returns `{ charts }` (parsed
 * from the model's JSON array); every other stage returns `{ text }`.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const stage = body.stage as Stage;
    if (!STAGES.has(stage)) {
      return NextResponse.json({ error: 'A valid stage is required (define|design|build|view|govern).' }, { status: 400 });
    }

    return await runStageAssistant({
      prompt: promptFor(stage, body),
      user,
      jsonKey: 'charts',
      expectArray: true,
      jsonError: 'The assistant did not return a usable chart list — try rephrasing.',
    });
  } catch (e) {
    return failResponse(e);
  }
}
