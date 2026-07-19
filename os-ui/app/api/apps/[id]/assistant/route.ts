/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser } from '@/lib/software/apps';
import { assistantComplete } from '@/lib/assistant/complete';

export const dynamic = 'force-dynamic';

/**
 * The per-STAGE Software assistant — one governed helper, scoped to the guided stage the
 * user is on (Describe · Build · Preview · Publish · Operate). It runs the SAME ONE
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

type Stage = 'describe' | 'build' | 'preview' | 'publish' | 'operate';
const STAGES = new Set<Stage>(['describe', 'build', 'preview', 'publish', 'operate']);

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
    case 'describe':
      return {
        system:
          'You help a business user brief a new software app they are about to build with a governed delivery team. Given their name and rough brief, suggest whether it likely needs a UI, an API, or both, and 3-4 concrete capabilities to ask the team to build first. Be concise: one short paragraph, then a short bullet list. Do not promise infrastructure — the team scaffolds a sovereign repo and ships through review.',
        user: `App name: ${app.name || '(unnamed)'}\nBrief: ${app.description || detail || '(none given)'}\nSuggest the surface and the first capabilities.`,
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
    case 'publish':
      return {
        system:
          'You explain a deploy security-scan finding or a missing-metadata blocker to a non-technical user, and propose the fix to hand to the build chat or delivery team. Two or three sentences. If asked to justify a go-live, write an honest 2-3 sentence request: what the app does, who it serves, why it is ready. No hype.',
        user: `App "${app.name}" (${surface}). Missing metadata: ${app.manifest.missing.join(', ') || 'none'}. The reviewer/user notes: ${detail || '(explain the scan findings and propose fixes)'}.`,
      };
    case 'operate':
      return {
        system:
          'You triage a live app problem for a non-technical operator: a denial, an error, or an unexpected tool result. Explain the likely cause in plain language and the single next step. Two or three sentences. Governed apps run as the user under OPA + row/document security, so denials are usually a missing grant, not a bug.',
        user: `App "${app.name}" is ${app.deploy.state} (v${app.deploy.releases}). Governed tools: ${app.mcpTools.map((t) => `${t.name}${t.write ? '(write)' : ''}`).join(', ') || 'none'}. The operator reports: ${detail || '(triage the current state)'}.`,
      };
  }
}

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
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
      return NextResponse.json({ error: 'A valid stage is required (describe|build|preview|publish|operate).' }, { status: 400 });
    }

    const app = await getAppForUser(id, user);
    const { system, user: userMsg } = promptFor(stage, app, body);
    const { content } = await assistantComplete(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      { user: { id: user.id, domains: user.domains } },
    );
    return NextResponse.json({ text: content });
  } catch (e) {
    return fail(e);
  }
}
