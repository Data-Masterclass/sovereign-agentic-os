/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser } from '@/lib/software/apps';
import { failResponse } from '@/lib/assistant/stage-route';
import { parseJsonReply } from '@/lib/assistant/json-reply';
import { assistantComplete } from '@/lib/assistant/complete';
import { roleModel } from '@/lib/models/roles';
import { availableContext, type AvailableContext } from '@/lib/software/available-context';
import { normalizeAssistantReply } from '@/lib/software/assistant-suggestions';
import { defineContextBlock } from '@/lib/software/define-context';
import { resolveGrantedContext } from '@/lib/software/grants-context';
import { CONTEXT_KINDS, type ContextGrants, type ContextKind } from '@/lib/core/context-grants';

export const dynamic = 'force-dynamic';

/**
 * The per-STAGE Software assistant — a real, governed CHAT helper scoped to the guided
 * stage the user is on (Define · Design · Build · Test · Publish). It runs the SAME
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
 *   • build / test / publish → `{ message: markdown, suggestions: {} }` (prose only)
 */

type Stage = 'define' | 'design' | 'build' | 'test' | 'publish';
const STAGES = new Set<Stage>(['define', 'design', 'build', 'test', 'publish']);
/**
 * Legacy stage aliases — the old flow named the last two stages `preview` and
 * `operate`. Accept them (a stale client / bookmarked call) and fold them into the
 * new vocabulary so nothing 400s during rollout.
 */
const STAGE_ALIAS: Record<string, Stage> = { preview: 'test', operate: 'publish' };
function coerceStage(v: unknown): Stage | null {
  if (typeof v !== 'string') return null;
  if (STAGES.has(v as Stage)) return v as Stage;
  return STAGE_ALIAS[v] ?? null;
}
/** The context kinds the Software Define stage may grant (mirrors SoftwareBuilder). */
const SW_GRANT_KINDS: ContextKind[] = ['connections', 'data', 'knowledge', 'files', 'metrics'];

type Turn = { role: 'user' | 'assistant'; content: string };

/** Whether a stage returns structured suggestions (JSON) or plain prose. */
function isStructured(stage: Stage): boolean {
  return stage === 'define' || stage === 'design' || stage === 'test';
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

/** The epic shape the Design digest reads (requirements + per-story spec presence). */
type DesignEpicDigest = {
  title: string;
  requirements?: { technical?: string; ux?: string; governance?: string };
  stories: { title: string; spec?: { features?: string[]; nfrs?: string[]; rules?: string[] } }[];
};

/**
 * A compact digest of the current epics for the Design prompt — each epic notes whether
 * it has requirements yet and, per story, whether a spec is authored. This lets the
 * assistant pick the RIGHT next ladder step (requirements vs stories vs specs) instead of
 * always stopping at stories.
 */
function epicsDigest(epics: DesignEpicDigest[]): string {
  if (epics.length === 0) return '(no epics yet)';
  const hasReqs = (r?: { technical?: string; ux?: string; governance?: string }) =>
    !!(r && ((r.technical ?? '').trim() || (r.ux ?? '').trim() || (r.governance ?? '').trim()));
  const specced = (s: { spec?: { features?: string[]; nfrs?: string[]; rules?: string[] } }) =>
    ((s.spec?.features?.length ?? 0) + (s.spec?.nfrs?.length ?? 0) + (s.spec?.rules?.length ?? 0)) > 0;
  return epics
    .map((e) => {
      const stories = e.stories.length
        ? e.stories.map((s) => `${s.title || '(untitled)'} [${specced(s) ? 'specced' : 'no spec'}]`).join('; ')
        : 'none';
      return `- ${e.title || '(untitled)'} [requirements: ${hasReqs(e.requirements) ? 'yes' : 'MISSING'}] — stories: ${stories}`;
    })
    .join('\n');
}

/** The story/spec shape the Test digest reads. */
type SpecEpicDigest = {
  stories: { id?: string; title: string; status?: string; spec?: { features?: string[]; nfrs?: string[]; rules?: string[] } }[];
};

/** A per-story spec digest (id · title · build status · the three spec lists) for the Test prompt. */
function specDigest(epics: SpecEpicDigest[]): string {
  const stories = epics.flatMap((e) => e.stories ?? []);
  if (stories.length === 0) return '(no stories yet)';
  return stories
    .map((s) => {
      const parts: string[] = [];
      if (s.spec?.features?.length) parts.push(`features: ${s.spec.features.join('; ')}`);
      if (s.spec?.nfrs?.length) parts.push(`NFRs: ${s.spec.nfrs.join('; ')}`);
      if (s.spec?.rules?.length) parts.push(`rules: ${s.spec.rules.join('; ')}`);
      const body = parts.length ? parts.join(' · ') : 'no spec authored';
      return `- [storyId: ${s.id ?? '?'}] ${s.title || '(untitled)'} [${s.status ?? 'todo'}] — ${body}`;
    })
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
        'You are the Design-stage assistant for a BUSINESS user (not a developer). You help SPECIFY a governed app by walking DOWN an artifact ladder: EPICs → each epic\'s REQUIREMENTS (technical/ux/governance) → USER STORIES → each story\'s SPEC (features = what it does, nfrs = how well, rules = governance/business rules).',
        'Ground every suggestion in the "Context from Define" block below (the chosen template, the app name/description and purpose) — never invent features the app is not about.',
        'You can SUGGEST: whole new epics (with description, requirements, and 2-3 stories); requirements for EXISTING epics that lack them (referenced by exact title); user stories for EXISTING epics (referenced by exact title); a spec (features/nfrs/rules) for the story the user is currently specifying; and a DATA PLAN — the datasets the app needs.',
        'DATA-RESOLUTION RULE — before this app can be built, every data-needing story must have its data RESOLVED: either an existing dataset is bound to the app, or a new one is created. Do NOT wait to discover data needs at build time. Read the stories/specs and identify the DATA ENTITIES the app needs (e.g. "employees", "cases", "service centers"). For each need: (1) if a SUITABLE existing dataset is visible in the "Granted context" / context below, prefer BINDING it via suggestedGrants (never duplicate an existing dataset); (2) otherwise propose a NEW dataset in suggestedDatasets with an inferred column schema, and choose fill: "empty" (schema only) when the user will load real data later, or "dummy" (with realistic sample rows) when the story should be immediately demoable. Ask the user which dataset for which purpose. Never invent columns unrelated to the story.',
        'FULL-TREE RULE — build the whole branch in ONE proposal, never in separate turns. When you propose epics, each epic MUST already include its "requirements" (technical/ux/governance) AND its "stories", and EACH story MUST already include its "spec" (features/nfrs/rules). When you propose stories for an existing epic, EACH story MUST already include its "spec". Do NOT defer requirements or specs to a later turn or tell the user to add them separately — you create the epic, its requirements, its stories AND their features/NFRs/rules together, in the same Apply.',
        'Keep it HONEST: propose real, specific requirements/features/NFRs/rules grounded in the app\'s purpose and the Context from Define — 2-4 concrete features per story, 1-2 real NFRs, 1-2 real governance/business rules. Do not pad with filler or generic boilerplate; if a story genuinely needs only one feature, give one.',
        'User stories use the "As a … I want … so that …" form with a short acceptance criterion.',
        'You NEVER mutate anything. You only suggest; the user clicks Apply to create.',
        'GUIDANCE RULE — never leave the user at a dead end. Whatever you just proposed, your "message" MUST end by telling them the SINGLE next step down the ladder and how to take it: after epics, tell them to fill in requirements or add stories; after stories, offer to draft their specs; when everything looks specified, say it looks ready to Build. If you cannot auto-generate the next artifact, say plainly what to type or which button to press (e.g. "expand a story and press Edit to add its features"). NEVER claim you created or saved anything — you only suggest; Apply is the user\'s click.',
        'Respond with STRICT JSON only (no prose outside it, no code fences), matching:',
        '{ "message": string (markdown; a short explanation of what you propose, ENDING with the one next step),',
        '  "suggestedEpics"?: [ { "title": string, "description": string, "requirements": { "technical": string, "ux": string, "governance": string }, "stories": [ { "title": string, "asA": string, "iWant": string, "soThat": string, "acceptance": string, "spec": { "features": string[], "nfrs": string[], "rules": string[] } } ] } ],',
        '  "suggestedEpicRequirements"?: [ { "epicTitle": exact title of an existing epic, "requirements": { "technical"?: string, "ux"?: string, "governance"?: string } } ],',
        '  "suggestedStories"?: [ { "epicTitle": exact title of an existing epic, "stories": [ { "title": string, "asA": string, "iWant": string, "soThat": string, "acceptance": string, "spec": { "features": string[], "nfrs": string[], "rules": string[] } } ] } ],',
        '  "suggestedSpec"?: { "features"?: string[], "nfrs"?: string[], "rules"?: string[] },',
        '  "suggestedGrants"?: [ { "kind": "data", "id": exact id of an EXISTING granted dataset from the context, "access"?: "read-only", "reason": short why } ],',
        '  "suggestedDatasets"?: [ { "name": string (the entity, e.g. "employees"), "purpose": short which story it serves, "columns": [ { "name": string, "type": string } ] (REQUIRED, non-empty), "fill": "empty"|"dummy", "rows"?: number (for dummy; default 25, max 100) } ] }',
        'For suggestedDatasets: infer a realistic, minimal column schema from the story (id + the fields it needs). Use suggestedGrants to BIND an existing dataset instead whenever one already fits — do not create a duplicate.',
        'Example of ONE full-tree epic (shape, keep content real): { "title": "Reminders", "description": "…", "requirements": { "technical": "Runs a daily scheduled job", "ux": "One-click snooze", "governance": "Sends only to opted-in users" }, "stories": [ { "title": "Send a due-date reminder", "asA": "user", "iWant": "an email before a task is due", "soThat": "I don\'t miss it", "acceptance": "Email arrives 24h before due", "spec": { "features": ["Compose reminder email", "Schedule 24h before due"], "nfrs": ["Sends within 1 min of trigger"], "rules": ["Only to opted-in users"] } } ] }',
        'Pick the field that matches the user\'s next ladder step: no epics yet → suggestedEpics (WITH requirements + stories + each story\'s spec); epics without stories → suggestedStories (WITH each story\'s spec); epics that only lack requirements → suggestedEpicRequirements; a story open/asking for its spec → suggestedSpec. Omit a field when you have nothing for it. Be concrete and concise.',
      ].join('\n');
    case 'build':
      return 'You explain, in plain language, what a file or piece of an in-progress app does, or what to ask the build chat next. Two or three sentences, markdown, no jargon dumps. The delivery-team chat and the build chat are the agents that actually write code — you only clarify. Return your answer as markdown prose.';
    case 'test':
      return [
        'You are the Test-stage verifier. Read the committed code and each BUILT story\'s spec (features, non-functional requirements, rules) and verify them honestly — report PASS/FAIL per item grounded in what you actually read, never claim something passed if you cannot see it.',
        'For every item that FAILS or falls short, draft ONE concrete improvement tied to that story (and feature index when specific). Classify each: "rebuild" when the built code just MISSED an existing spec item (the fix is to re-build that feature; spec unchanged); "design" when the feedback CHANGES what was asked (a new/changed requirement that must be specified in Design first). Free-form user feedback is classified the same way.',
        'You NEVER mutate anything — you only report + suggest improvements; the user turns them into Build items.',
        'Respond with STRICT JSON only (no prose outside it, no code fences), matching:',
        '{ "message": string (markdown; the PASS/FAIL summary per story/item, grounded),',
        '  "suggestedImprovements"?: [ { "kind": "rebuild"|"design", "storyId": exact id of a built story, "featureIndex"?: number, "note": short what-to-change } ] }',
        'Only reference story ids present in the context. Omit suggestedImprovements when everything passes. Never fabricate a test result.',
      ].join('\n');
    case 'publish':
      return 'You help a non-technical operator PUBLISH and run the live app — requesting go-live (explaining a deploy security-scan finding or missing-metadata blocker and proposing the fix, or an honest 2-3 sentence go-live justification) AND triaging a live app problem (a denial, an error, an unexpected tool result). Explain the likely cause in plain language and the single next step. Governed apps run as the user under OPA + row/document security, so denials are usually a missing grant, not a bug. Return your answer as markdown prose.';
  }
}

/** Build the user-turn context block prepended to the conversation. */
function contextBlock(
  stage: Stage,
  app: {
    name: string;
    description: string;
    purpose: string;
    template: string;
    epics: { title: string; requirements?: { technical?: string; ux?: string; governance?: string }; stories: { id?: string; title: string; status?: string; spec?: { features?: string[]; nfrs?: string[]; rules?: string[] } }[] }[];
    surface: { ui: boolean; api: boolean };
    pipeline: Record<string, string>;
    deploy: { state: string; previewUrl: string | null; releases: number };
    manifest: { missing: string[] };
    mcpTools: { name: string; write: boolean }[];
  },
  available: AvailableContext | null,
  grantedContext: string,
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
      return [
        head,
        defineContextBlock({ name: app.name, description: app.description, template: app.template, purpose: app.purpose }),
        // The REAL granted artifacts (DLS-scoped) so specs reference real columns/members,
        // never invented ones. Empty grants ⇒ '' (filtered out, zero prompt cost).
        grantedContext,
        'Current epics:',
        epicsDigest(app.epics),
      ].filter(Boolean).join('\n');
    case 'build':
      return head;
    case 'test':
      return [
        `App "${app.name}". Deploy state: ${app.deploy.state}. Preview URL: ${app.deploy.previewUrl ? 'served' : 'not yet'}. Pipeline: ${pipeline}.`,
        `Purpose: ${app.purpose || '(none)'}`,
        'Stories to test (title — spec):',
        specDigest(app.epics),
      ].join('\n');
    case 'publish':
      return `App "${app.name}" (${surface}) is ${app.deploy.state} (v${app.deploy.releases}). Missing metadata: ${app.manifest.missing.join(', ') || 'none'}. Governed tools: ${app.mcpTools.map((t) => `${t.name}${t.write ? '(write)' : ''}`).join(', ') || 'none'}.`;
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
    const stage = coerceStage(body.stage);
    if (!stage) {
      return NextResponse.json({ error: 'A valid stage is required (define|design|build|test|publish).' }, { status: 400 });
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

    // Design grounds the spec in the REAL granted context (data schema, knowledge, metrics,
    // files, connections), resolved AS the caller so it never leaks anything they can't see.
    const grantedContext =
      stage === 'design' ? await resolveGrantedContext(app.grants as ContextGrants, user) : '';

    const messages = [
      { role: 'system' as const, content: systemFor(stage) },
      { role: 'user' as const, content: contextBlock(stage, app, available, grantedContext) },
      ...turns,
    ];

    // Per-stage MODEL TIER (Software tab policy): Design (spec/plan drafting) and Test
    // (verify against spec) are reasoning-heavy → the REASONING model; the light prose
    // helpers (build/publish) stay on the default assistant model.
    const stageModel = stage === 'design' || stage === 'test' ? roleModel('reasoning') : undefined;
    const { content } = await assistantComplete(messages, { user: { id: user.id, domains: user.domains }, model: stageModel });

    if (!isStructured(stage)) {
      // `text` is retained for the legacy one-shot StageAssistant stub; `message` is the
      // new chat field. Same content, both keys.
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
