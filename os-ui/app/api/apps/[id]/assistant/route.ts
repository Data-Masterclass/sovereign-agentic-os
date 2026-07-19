/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser } from '@/lib/software/apps';
import { failResponse, runStageAssistant } from '@/lib/assistant/stage-route';

export const dynamic = 'force-dynamic';

/**
 * The per-STAGE Software assistant — one governed helper, scoped to the guided stage the
 * user is on (Define · Design · Build · Preview · Operate). It runs the SAME ONE
 * assistant model every other built-in helper uses (`assistantComplete`: Langfuse-audited,
 * cost-cap enforced), so it inherits the honest 503 (no model configured) and 402 (cost
 * cap) errors — there is NO fake-AI fallback. The model only SUGGESTS text; it never
 * mutates an app (the delivery team + build chat are the mutating agents). The response is
 * always `{ text }`.
 *
 * It is READ-ONLY over the app: it loads the app under the caller's governance (so a user
 * who can't see the app can't ask about it) and feeds real state — the pipeline, the deploy
 * state, the running preview URL — into the prompt so triage is grounded, never invented.
 */

type Stage = 'define' | 'design' | 'build' | 'preview' | 'operate';
const STAGES = new Set<Stage>(['define', 'design', 'build', 'preview', 'operate']);

/** Build the stage-scoped system + user prompt pair from the app + request body. */
function promptFor(
  stage: Stage,
  app: {
    name: string;
    description: string;
    surface: { ui: boolean; api: boolean };
    pipeline: Record<string, string>;
    deploy: { state: string; previewUrl: string | null; releases: number };
    manifest: { missing: string[] };
    mcpTools: { name: string; write: boolean }[];
  },
  body: Record<string, unknown>,
): { system: string; user: string } {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const detail = s(body.detail);
  const surface = [app.surface.ui ? 'UI' : '', app.surface.api ? 'API' : ''].filter(Boolean).join(' + ') || 'unknown';
  const pipeline = Object.entries(app.pipeline).map(([k, v]) => `${k}=${v}`).join(', ') || '(no pipeline yet)';

  switch (stage) {
    case 'define':
      return {
        system:
          'You help a business user state the PURPOSE of a new software app they are about to build with a governed delivery team. Given their name and rough brief, write a crisp one-sentence purpose, then suggest whether it likely needs a UI, an API, or both, and 3-4 concrete capabilities to build first. Be concise: the purpose sentence, then a short bullet list. Do not promise infrastructure — the team scaffolds a sovereign repo and ships through review.',
        user: `App name: ${app.name || '(unnamed)'}\nBrief: ${app.description || detail || '(none given)'}\nWrite the purpose and suggest the first capabilities.`,
      };
    case 'design':
      return {
        system:
          'You help a business user shape an app as agile EPICs and user stories. Given the app purpose, propose one or two EPICs, each with a one-line description and 2-3 user stories in "As a … I want … so that …" form plus a short acceptance criterion. Be concise and concrete — no framework lecture. The user edits these into the Design editor.',
        user: `App "${app.name}" (${surface}). Purpose/notes: ${app.description || detail || '(none given)'}. Propose EPICs and user stories.`,
      };
    case 'build':
      return {
        system:
          'You explain, in plain language, what a file or piece of an in-progress app does, or what to ask the build chat next. Two or three sentences, no jargon dumps. The delivery-team chat and the build chat are the agents that actually write code — you only clarify.',
        user: `App "${app.name}" (${surface}). The user asks: ${detail || '(explain what to build next)'}.`,
      };
    case 'preview':
      return {
        system:
          'You explain why a preview pod might not be ready yet, reading the real pipeline stages, and the single most useful next step. Two or three sentences. Common honest causes: CI still building the image, no cluster reachable (URL stays pending), or a failed stage. Never claim it is ready if the state says otherwise.',
        user: `App "${app.name}". Deploy state: ${app.deploy.state}. Preview URL: ${app.deploy.previewUrl ? 'served' : 'not yet'}. Pipeline: ${pipeline}. Explain why the preview isn't ready and what to try.`,
      };
    case 'operate':
      return {
        system:
          'You help a non-technical operator with the Operate stage — which covers requesting go-live (explaining a deploy security-scan finding or missing-metadata blocker and proposing the fix, or writing an honest 2-3 sentence go-live justification) AND triaging a live app problem (a denial, an error, an unexpected tool result). Explain the likely cause in plain language and the single next step. Two or three sentences. Governed apps run as the user under OPA + row/document security, so denials are usually a missing grant, not a bug.',
        user: `App "${app.name}" (${surface}) is ${app.deploy.state} (v${app.deploy.releases}). Missing metadata: ${app.manifest.missing.join(', ') || 'none'}. Governed tools: ${app.mcpTools.map((t) => `${t.name}${t.write ? '(write)' : ''}`).join(', ') || 'none'}. The operator notes: ${detail || '(triage the current state)'}.`,
      };
  }
}

/**
 * POST { stage, detail? } → a stage-scoped `{ text }` suggestion, grounded in the real app
 * loaded under the caller's governance.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const stage = body.stage as Stage;
    if (!STAGES.has(stage)) {
      return NextResponse.json({ error: 'A valid stage is required (define|design|build|preview|operate).' }, { status: 400 });
    }

    const app = await getAppForUser(id, user);
    // Software only SUGGESTS prose — every stage returns { text }.
    return await runStageAssistant({ prompt: { ...promptFor(stage, app, body), json: false }, user });
  } catch (e) {
    return failResponse(e);
  }
}
