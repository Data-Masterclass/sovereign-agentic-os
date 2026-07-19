/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser } from '@/lib/software/apps';
import { failResponse } from '@/lib/assistant/stage-route';
import { assistantComplete } from '@/lib/assistant/complete';
import { availableContext, type AvailableContext } from '@/lib/software/available-context';
import { normalizeAssistantReply } from '@/lib/software/assistant-suggestions';
import { CONTEXT_KINDS, type ContextKind } from '@/lib/core/context-grants';

export const dynamic = 'force-dynamic';

/**
 * The per-STAGE Software assistant — a real, governed CHAT helper scoped to the guided
 * stage the user is on (Define · Design · Build · Preview · Operate). It runs the SAME
 * ONE assistant model every other built-in helper uses (`assistantComplete`:
 * Langfuse-audited, cost-cap enforced), so it inherits the honest 503 (no model
 * configured) and 402 (cost cap) errors — there is NO fake-AI fallback.
 *
 * It only SUGGESTS: the model returns prose + structured suggestion cards; APPLYING a
 * suggestion is a local, user-confirmed transform the client persists through the normal
 * governed path (`patchAppDesign`). The model never mutates an app.
 *
 * READ-ONLY over the app: it loads the app under the caller's governance (so a user who
 * can't see the app can't ask about it) and feeds REAL state — the purpose, the epics,
 * the pipeline, the deploy state — plus, for Define, the caller's DLS-scoped grantable
 * artifacts, so every suggestion references real ids, never invented ones.
 *
 * Response:
 *   • define / design → `{ message: markdown, suggestions: {...} }`
 *   • build / preview / operate → `{ message: markdown, suggestions: {} }` (prose only)
 */

type Stage = 'define' | 'design' | 'build' | 'preview' | 'operate';
const STAGES = new Set<Stage>(['define', 'design', 'build', 'preview', 'operate']);
/** The context kinds the Software Define stage may grant (mirrors SoftwareBuilder). */
const SW_GRANT_KINDS: ContextKind[] = ['connections', 'data', 'knowledge', 'files', 'metrics'];

type Turn = { role: 'user' | 'assistant'; content: string };

/** Whether a stage returns structured suggestions (JSON) or plain prose. */
function isStructured(stage: Stage): boolean {
  return stage === 'define' || stage === 'design';
}

/** Coerce an arbitrary request `messages` field into a clean, bounded turn list. */
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

/** A compact, id-carrying digest of what the caller can grant, for the Define prompt. */
function grantsDigest(available: AvailableContext): string {
  const lines: string[] = [];
  for (const kind of CONTEXT_KINDS) {
    const items = available[kind] ?? [];
    if (items.length === 0) continue;
    const shown = items.slice(0, 40).map((i) => `${i.id} — ${i.name} [${i.scope}]`);
    lines.push(`${kind}:\n  ${shown.join('\n  ')}`);
  }
  return lines.join('\n') || '(no grantable artifacts visible to you yet)';
}

/** A compact digest of the current epics (titles + story titles) for the Design prompt. */
function epicsDigest(epics: { title: string; stories: { title: string }[] }[]): string {
  if (epics.length === 0) return '(no epics yet)';
  return epics
    .map((e) => `- ${e.title || '(untitled)'} — stories: ${e.stories.map((s) => s.title || '(untitled)').join(', ') || 'none'}`)
    .join('\n');
}

/** Build the stage-scoped system prompt. Structured stages demand strict JSON. */
function systemFor(stage: Stage): string {
  switch (stage) {
    case 'define':
      return [
        'You are the Define-stage assistant for a governed software app a business user is about to build.',
        'Your two jobs: (1) help SHARPEN the app PURPOSE into one crisp sentence, and (2) SUGGEST which governed context (connections, data, knowledge, files, metrics) the app should be granted — chosen ONLY from the caller\'s "Grantable context" list, referenced by their exact id.',
        'You NEVER mutate anything. You only suggest; the user clicks Apply to accept.',
        'Respond with STRICT JSON only (no prose outside it, no code fences), matching:',
        '{ "message": string (markdown; a short, friendly explanation of what you suggest and why),',
        '  "improvedPurpose"?: string (a single crisp purpose sentence — omit if the current purpose is already good),',
        '  "suggestedGrants"?: [ { "kind": one of connections|data|knowledge|files|metrics, "id": exact id from the grantable list, "access"?: read-only|read-propose|read-write, "reason": short why } ] }',
        'Only propose grants whose id appears in the grantable list. Prefer read-only unless the purpose clearly needs writes. If nothing fits, omit the field. Keep "message" to a few sentences.',
      ].join('\n');
    case 'design':
      return [
        'You are the Design-stage assistant. You help shape a governed app as agile EPICs and user stories.',
        'You can SUGGEST whole new epics (each with a description, technical/ux/governance requirements, and 2-3 user stories) AND suggest additional user stories for EXISTING epics (referenced by their exact title).',
        'User stories use the "As a … I want … so that …" form with a short acceptance criterion.',
        'You NEVER mutate anything. You only suggest; the user clicks Apply to create.',
        'Respond with STRICT JSON only (no prose outside it, no code fences), matching:',
        '{ "message": string (markdown; a short explanation of the epics/stories you propose),',
        '  "suggestedEpics"?: [ { "title": string, "description": string, "requirements": { "technical": string, "ux": string, "governance": string }, "stories": [ { "title": string, "asA": string, "iWant": string, "soThat": string, "acceptance": string } ] } ],',
        '  "suggestedStories"?: [ { "epicTitle": exact title of an existing epic, "stories": [ { "title": string, "asA": string, "iWant": string, "soThat": string, "acceptance": string } ] } ] }',
        'If there are no epics yet, propose 1-2 epics via suggestedEpics. If epics exist, prefer adding stories to them via suggestedStories. Omit a field when you have nothing for it. Be concrete and concise.',
      ].join('\n');
    case 'build':
      return 'You explain, in plain language, what a file or piece of an in-progress app does, or what to ask the build chat next. Two or three sentences, markdown, no jargon dumps. The delivery-team chat and the build chat are the agents that actually write code — you only clarify. Return your answer as markdown prose.';
    case 'preview':
      return 'You explain why a preview pod might not be ready yet, reading the real pipeline stages, and the single most useful next step. Two or three sentences, markdown. Common honest causes: CI still building the image, no cluster reachable (URL stays pending), or a failed stage. Never claim it is ready if the state says otherwise.';
    case 'operate':
      return 'You help a non-technical operator with the Operate stage — requesting go-live (explaining a deploy security-scan finding or missing-metadata blocker and proposing the fix, or an honest 2-3 sentence go-live justification) AND triaging a live app problem (a denial, an error, an unexpected tool result). Explain the likely cause in plain language and the single next step. Governed apps run as the user under OPA + row/document security, so denials are usually a missing grant, not a bug. Return your answer as markdown prose.';
  }
}

/** Build the user-turn context block prepended to the conversation. */
function contextBlock(
  stage: Stage,
  app: {
    name: string;
    description: string;
    purpose: string;
    epics: { title: string; stories: { title: string }[] }[];
    surface: { ui: boolean; api: boolean };
    pipeline: Record<string, string>;
    deploy: { state: string; previewUrl: string | null; releases: number };
    manifest: { missing: string[] };
    mcpTools: { name: string; write: boolean }[];
  },
  available: AvailableContext | null,
): string {
  const surface = [app.surface.ui ? 'UI' : '', app.surface.api ? 'API' : ''].filter(Boolean).join(' + ') || 'unknown';
  const pipeline = Object.entries(app.pipeline).map(([k, v]) => `${k}=${v}`).join(', ') || '(no pipeline yet)';
  const head = `App "${app.name || '(unnamed)'}" (${surface}). Description: ${app.description || '(none)'}.`;
  switch (stage) {
    case 'define':
      return [
        head,
        `Current purpose: ${app.purpose || '(not set yet)'}`,
        'Grantable context (id — name [scope]) — propose grants ONLY from this list, by exact id:',
        grantsDigest(available ?? ({} as AvailableContext)),
      ].join('\n');
    case 'design':
      return [head, `Purpose: ${app.purpose || '(none)'}`, 'Current epics:', epicsDigest(app.epics)].join('\n');
    case 'build':
      return head;
    case 'preview':
      return `App "${app.name}". Deploy state: ${app.deploy.state}. Preview URL: ${app.deploy.previewUrl ? 'served' : 'not yet'}. Pipeline: ${pipeline}.`;
    case 'operate':
      return `App "${app.name}" (${surface}) is ${app.deploy.state} (v${app.deploy.releases}). Missing metadata: ${app.manifest.missing.join(', ') || 'none'}. Governed tools: ${app.mcpTools.map((t) => `${t.name}${t.write ? '(write)' : ''}`).join(', ') || 'none'}.`;
  }
}

/** Strip stray ```json fences before parsing a structured reply. */
function parseJsonReply(content: string): unknown {
  const cleaned = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * POST { stage, messages: [{role, content}], detail? } → a stage-scoped reply.
 * Structured stages (define/design) return `{ message, suggestions }`; prose stages
 * return `{ message, suggestions: {} }`. Grounded in the real app under the caller's
 * governance; the model only suggests.
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

    // Compose the conversation: system + a context block + the user's turns. A legacy
    // caller that sent only { detail } still works — we synthesise a first user turn.
    const turns = readTurns(body);
    const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
    if (turns.length === 0 && detail) turns.push({ role: 'user', content: detail });
    if (turns.length === 0) {
      // No question yet — a neutral opener so the stage can still offer suggestions.
      turns.push({ role: 'user', content: stage === 'define' ? 'Help me improve the purpose and suggest context to grant.' : stage === 'design' ? 'Suggest epics and user stories from the purpose.' : 'Help me with this stage.' });
    }

    // Define needs the DLS-scoped grantable set so it references real ids.
    const available =
      stage === 'define' ? await availableContext(user, SW_GRANT_KINDS) : null;

    const messages = [
      { role: 'system' as const, content: systemFor(stage) },
      { role: 'user' as const, content: contextBlock(stage, app, available) },
      ...turns,
    ];

    const { content } = await assistantComplete(messages, { user: { id: user.id, domains: user.domains } });

    if (!isStructured(stage)) {
      // `text` is retained for the legacy one-shot StageAssistant stub (build/preview/
      // operate); `message` is the new chat field. Same content, both keys.
      return NextResponse.json({ message: content, text: content, suggestions: {} });
    }

    const parsed = parseJsonReply(content);
    if (!parsed || typeof parsed !== 'object') {
      // Honest fallback: the model didn't return JSON — surface its text as the message,
      // with no suggestions, rather than a fake success.
      return NextResponse.json({ message: content || 'The assistant did not return a usable result — try rephrasing.', suggestions: {} });
    }
    const reply = normalizeAssistantReply(parsed, SW_GRANT_KINDS);
    return NextResponse.json({ message: reply.message || content, suggestions: reply.suggestions });
  } catch (e) {
    return failResponse(e);
  }
}
