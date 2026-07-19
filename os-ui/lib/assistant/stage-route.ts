/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { assistantComplete } from '@/lib/assistant/complete';

/**
 * Shared scaffolding for the per-STAGE tab assistants (Data · Metrics · Dashboards ·
 * Science · Software). Every one of those routes runs the SAME ONE governed model via
 * {@link assistantComplete} (Langfuse-audited, cost-cap enforced), so they all inherit the
 * honest 503 (no model configured) and 402 (cost cap) errors — there is NO fake-AI
 * fallback. The model only SUGGESTS; the client applies suggestions through the normal
 * governed paths.
 *
 * This module lifts the *mechanical* bits every route copied byte-for-byte — the error →
 * status mapper, the stage validation, the `assistantComplete([system,user])` call, and the
 * defensive JSON-fence strip/parse — WITHOUT owning any stage definitions or prompts, which
 * stay local to each tab (they differ). A route reduces to its `promptFor` table plus one
 * call to {@link runStageAssistant}.
 */

/** Map a thrown error to `{ error }` at its `.status` (default 500) — the shared route tail. */
export function failResponse(e: unknown): NextResponse {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** The system + user prompt pair a stage produces, plus whether the model must return JSON. */
export type StagePrompt = { system: string; user: string; json: boolean };

/** Caller identity threaded to the audited, cost-capped model. */
export type StageUser = { id: string; domains?: string[] };

/**
 * Options for {@link runStageAssistant}.
 *
 * When a stage's {@link StagePrompt.json} is true, the model's reply is fence-stripped and
 * `JSON.parse`d defensively; the parsed value is returned under `jsonKey` (e.g. `draft`,
 * `form`, `charts`, `definition`). `expectArray` guards the shape — array vs object — and a
 * bad shape yields a 502 with `jsonError`. Prose stages always return `{ text }`.
 */
export type StageAssistantOptions = {
  /** The prompt pair for this stage (already built from the request body by the route). */
  prompt: StagePrompt;
  /** Caller identity for audit attribution + cost-cap scoping. */
  user: StageUser;
  /** The response key for a JSON stage's parsed payload (required when `prompt.json`). */
  jsonKey?: string;
  /** True when the JSON stage must return an array (e.g. Dashboards charts); default object. */
  expectArray?: boolean;
  /** The 502 message when a JSON stage returns an unusable shape. */
  jsonError?: string;
};

/**
 * Run one stage-scoped completion and shape the response exactly as the tab routes did:
 * prose → `{ text }`; JSON → `{ [jsonKey]: parsed }` (502 on unusable shape). Callers wrap
 * this in try/catch and hand thrown errors to {@link failResponse}.
 */
export async function runStageAssistant(opts: StageAssistantOptions): Promise<NextResponse> {
  const { prompt, user } = opts;
  const { content } = await assistantComplete(
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    { user: { id: user.id, domains: user.domains } },
  );

  if (!prompt.json) return NextResponse.json({ text: content });

  // JSON stage: strip stray code fences, parse defensively, guard the expected shape.
  const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = null;
  }
  const ok = opts.expectArray
    ? Array.isArray(parsed)
    : !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  if (!ok) {
    return NextResponse.json(
      { error: opts.jsonError ?? 'The assistant did not return a usable result — try rephrasing.' },
      { status: 502 },
    );
  }
  return NextResponse.json({ [opts.jsonKey ?? 'result']: parsed });
}
