/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { roleModel } from '@/lib/models/roles';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser, saveChat } from '@/lib/software/apps';
import { getSnapshot } from '@/lib/software/snapshot';
import { diffTrees, type FileChange } from '@/lib/software/build-changeset';
import { runTabAgent, renderAssistantText } from '@/lib/assistant/runtime';
import { AssistantNotConfiguredError } from '@/lib/assistant/complete';
import { toolCallToLine, committedSummaryLine, type ActivityLine } from '@/lib/software/build-activity';
import { asChatRunMode, isReadOnlyMode, modeDirective, modelRoleForMode, READ_ONLY_MODE_TOOLS, type ChatRunMode } from '@/lib/software/chat-modes';
import { defineContextBlock, specPromptLines as specLines } from '@/lib/software/define-context';
import type { BuildTarget } from '@/lib/software/build-target';

export const dynamic = 'force-dynamic';

type Msg = { role: 'user' | 'assistant'; content: string };

/**
 * A concise, ACCURATE description of the OS-client SDK surface + the `vite-os`
 * scaffold conventions, injected into the build brief for governed frontend apps
 * (template `vite-os`). It is grounded in the REAL SDK (`lib/app-sdk/client.ts`):
 * every method below exists — do NOT let the model invent others. Data and auth
 * come from the OS over its governed routes, never a custom backend the app ships.
 */
const OS_SDK_BRIEF = [
  '## This app is a GOVERNED FRONTEND over the OS API (vite-os)',
  'This is a Vite + React + TypeScript + Tailwind + shadcn/ui SPA. It has NO custom',
  'backend and NO database of its own: all data and identity come from the Sovereign',
  'OS over its governed, OPA-checked, RLS/DLS-filtered routes. The app reaches them',
  'ONLY through the OS-client SDK, imported as `@sovereign-os/app-sdk`.',
  '',
  'Create the client once and reuse it:',
  "  import { createOsClient } from '@sovereign-os/app-sdk';",
  '  const os = createOsClient(); // same-origin ambient session (the preview case)',
  '',
  'The COMPLETE SDK method surface (use ONLY these — do not invent methods):',
  '  os.whoami()                     -> the signed-in principal { user: {...} | null }',
  '  os.context()                    -> granted context: { connections, data, knowledge, files, metrics }',
  '                                     (each an array of { id, name, scope?, folder? })',
  '  os.datasets.list()              -> datasets the user may see',
  '  os.datasets.get(id)             -> one dataset',
  '  os.datasets.query(id, q?)       -> q = { nl } (natural-language question, governed NL->SQL)',
  '                                     or omit for a governed row preview ({ limit }).',
  '                                     RAW SQL IS REFUSED (throws UnsupportedQuery).',
  '  os.metrics.list()               -> metrics the user may see',
  '  os.metrics.query(id, q?)        -> slice a metric: q = { dimensions?, timeDimension?, granularity?, filters? }',
  '  os.knowledge.search(q)          -> KnowledgeHit[] from the DLS-scoped knowledge index',
  '  os.files.list()                 -> files the user may see',
  '  os.files.get(id)                -> one file',
  '',
  'Honesty + errors (from the SDK): a failed governed call throws a typed error —',
  'NotAuthenticated (401), Forbidden (403, carries the server reason), UnsupportedQuery,',
  'or OsError. NEVER catch these and substitute mock/placeholder data: surface the real',
  'state (loading / empty / the error message). Real data or a real error, never a fake.',
  '',
  'Scaffold conventions: entry `src/main.tsx` -> `src/App.tsx`; the client factory lives',
  'in `src/os.ts`. The OS design system is vendored as `@sovereign-os/ui` — its theme is',
  'imported once in `src/index.css` (`@import \'@sovereign-os/ui/theme.css\'`) and the app is',
  'wrapped in its `AppShell` with the OS primitives (Section, Card, Table, Badge). Tailwind is',
  'still available in `src/index.css` for custom work. Build output is `dist/`, served by nginx',
  'on port 8080. Keep imports pointing at `@sovereign-os/app-sdk` + `@sovereign-os/ui` and',
  'follow the existing file layout.',
].join('\n');

/**
 * The per-app BUILD CHAT (Software golden path §2) — now genuinely AGENTIC. It
 * runs the shared PLAN → ACT → deploy(gated) harness scoped to the `software` MCP
 * tools: it plans with the reasoning tier, then acts with the exec tier, calling
 * the SAME governed pipeline the UI + MCP use — `commit` (scaffold + commit to
 * Forgejo → auto-MCP → CI scan), `start_preview`, and `request_deploy` (which
 * opens the Builder review gate; it never goes live on its own). THIS app's full
 * context (design decisions, data model, docs, repo, and its appId) is injected
 * so the agent builds coherently; the running conversation is persisted under the
 * app (home of record).
 */
function appContext(
  app: {
    id: string;
    name: string;
    description?: string;
    purpose?: string;
    template: string;
    subdomain: string;
    repo: { fullName: string };
    designDecisions: string;
    dataDescriptions: string;
    docs: string;
    epics?: { id: string; title: string; stories: { id: string; title: string; asA: string; iWant: string; soThat: string; acceptance: string; spec?: { features?: string[]; nfrs?: string[]; rules?: string[] } }[] }[];
  },
  mode: ChatRunMode,
  target: BuildTarget | null,
): string {
  // Governed OS frontends: every Vite-based scaffold (vite-os, sovereign-app,
  // website, empty) — the vendored SDK/UI brief applies to all of them.
  const isGovernedFrontend = ['vite-os', 'sovereign-app', 'website', 'empty'].includes(app.template);
  const isSovereignApp = app.template === 'sovereign-app';
  const stackLine =
    app.template === 'api-service'
      ? 'It is an APIs-only service (zero-dependency Node HTTP server, NO user interface) that lives in its own Forgejo repo'
      : isGovernedFrontend
        ? 'It is a Vite + React governed OS-frontend app that lives in its own Forgejo repo'
        : 'It is a Next.js + Supabase app that lives in its own Forgejo repo';
  const lines = [
    `You are the build assistant for the "${app.name}" application (appId: ${app.id}).`,
    stackLine,
    `(${app.repo.fullName}) and ships via Forgejo Actions → Harbor → Argo CD to`,
    `${app.subdomain}.`,
    // The full Define context (template + name + description + purpose) grounds every
    // code change — features are built from what the app IS, never invented.
    '',
    defineContextBlock(app),
  ];

  // Governed-frontend apps talk to the OS only through the OS-client SDK — teach
  // the harness the real SDK surface + scaffold conventions so generated code is
  // grounded (never invents methods, never fabricates data).
  if (isGovernedFrontend) {
    lines.push('', OS_SDK_BRIEF);
  }
  // The Sovereign standard app carries a skeleton contract (also in ## Docs below):
  // keep it intact and extend it section-by-section.
  if (isSovereignApp) {
    lines.push(
      '',
      '## Sovereign standard app — skeleton contract + code structure',
      'This app is a Sovereign standard app. Its code MIRRORS the epic/story spec:',
      '  • src/template/ — the FIXED scaffold: OS-delegated identity (template/identity.tsx —',
      '    no local accounts/passwords, ever), the scope helpers (template/scope.ts — every',
      '    record carries owner + domain), roles, app-meta, the AppShell layout (template/',
      '    shell.tsx), the section registry (template/sections.tsx) and the Admin/Overview',
      '    pages. NEVER remove it.',
      '  • src/core/ — overarching custom functionality + the SHARED governed data plane',
      '    (core/store.ts — the OS SDK, NOT Supabase) and shared pages.',
      '  • src/epics/<epic>/<story>/ — where each built story\'s feature code + its data go;',
      '    src/epics/<epic>/general/ for epic-wide shared code.',
      '  • src/App.tsx / src/main.tsx — THIN entrypoints ONLY (they mount the template Shell).',
      'To add a feature: create src/epics/<epic>/<story>/<Name>.tsx and register ONE entry in',
      'src/template/sections.tsx (nav + routing). Keep template/ intact and the entrypoints',
      'thin. See ## Docs for the full skeleton guide and the code-structure convention.',
    );
  }

  // The `## Mode: …` directive (plan/build/test/review) — pure, unit-tested.
  lines.push('', ...modeDirective(mode, app.id));

  // The targeted scope from the epic/story tree: a single story (the classic
  // target), an EPIC (work its stories in order), or nothing (= whole app).
  if (target?.kind === 'story') {
    const epic = app.epics?.find((e) => e.id === target.epicId);
    const st = epic?.stories.find((s) => s.id === target.storyId);
    if (st) {
      lines.push(
        '',
        '## Target story (THIS story is the scope)',
        `EPIC: ${epic?.title || '(untitled)'}`,
        `Story: ${st.title || '(untitled)'}`,
        `As a ${st.asA || '…'}, I want ${st.iWant || '…'}, so that ${st.soThat || '…'}.`,
        st.acceptance ? `Acceptance: ${st.acceptance}` : '',
        ...specLines(st.spec),
        'Focus this turn on exactly this story; deliver its features to spec.',
      );
    }
  } else if (target?.kind === 'epic') {
    const epic = app.epics?.find((e) => e.id === target.epicId);
    if (epic) {
      lines.push(
        '',
        '## Target EPIC (THIS epic is the scope)',
        `EPIC: ${epic.title || '(untitled)'}`,
        'Its stories, in order:',
        ...epic.stories.map((s, i) => {
          const acceptance = s.acceptance ? ` Acceptance: ${s.acceptance}` : '';
          const spec = specLines(s.spec);
          const specSuffix = spec.length ? ` [${spec.join(' | ')}]` : '';
          return `${i + 1}. ${s.title || '(untitled)'} — as a ${s.asA || '…'}, I want ${s.iWant || '…'}, so that ${s.soThat || '…'}.${acceptance}${specSuffix}`;
        }),
        mode === 'build'
          ? 'Work the stories IN ORDER, each to its acceptance criteria; state clearly which you delivered this turn.'
          : 'Cover every story of this EPIC in your response.',
      );
    }
  }

  lines.push(
    '',
    '## Design decisions',
    app.designDecisions || '(none yet)',
    '',
    '## Data descriptions',
    app.dataDescriptions || '(none yet)',
    '',
    '## Docs',
    app.docs || '(none yet)',
  );
  return lines.join('\n');
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { id } = await ctx.params;

  let messages: Msg[] = [];
  let mode: ChatRunMode = 'build';
  let target: BuildTarget | null = null;
  try {
    const body = await req.json();
    messages = Array.isArray(body?.messages) ? body.messages : [];
    mode = asChatRunMode(body?.mode);
    // The targeted scope: `target` ({kind, epicId?, storyId?}) is the current shape;
    // the legacy `story` ({epicId, storyId}) stays accepted for backward compat.
    const t = body?.target;
    if (t?.kind === 'app') target = { kind: 'app' };
    else if (t?.kind === 'epic' && typeof t.epicId === 'string') target = { kind: 'epic', epicId: t.epicId };
    else if (t?.kind === 'story' && typeof t.epicId === 'string' && typeof t.storyId === 'string') {
      target = { kind: 'story', epicId: t.epicId, storyId: t.storyId };
    } else if (body?.story && typeof body.story.epicId === 'string' && typeof body.story.storyId === 'string') {
      target = { kind: 'story', epicId: body.story.epicId, storyId: body.story.storyId };
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let app;
  try {
    app = await getAppForUser(id, user);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 404 });
  }

  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
  if (clean.length === 0) return NextResponse.json({ error: 'No message to send' }, { status: 400 });

  // Snapshot the app's committed tree BEFORE the run so we can surface the exact
  // before/after changeset a Build turn produced (the harness commits through
  // `commitToApp`, which updates this same per-app snapshot).
  const before = getSnapshot(app.id);
  // Per-stage MODEL TIER (Software tab policy): plan (Design) / test / review run on the
  // REASONING model — the spec-drafting, verification and review reasoning; build (code
  // GENERATION) runs on STANDARD — the standard model does the bulk file writing and is
  // NEVER auto-escalated to reasoning. See lib/software/chat-modes.ts modelRoleForMode.
  const model = roleModel(modelRoleForMode(mode));

  /**
   * STREAMING Build run (SSE, text/event-stream). Each event is one JSON line
   * prefixed `data: `. The client renders `activity` events as a live feed AS
   * the agent works, then the terminal `final` event carries the backward-
   * compatible payload ({ content, changes }) the old one-shot client relied on.
   *
   * Event shapes (all `{ type, ... }`):
   *   { type: 'plan', text }                          — the plan, once, first
   *   { type: 'activity', line: ActivityLine, raw }   — one per tool step, live
   *   { type: 'final', role, content, model, mode, changes }
   *   { type: 'error', message }                      — a run-level failure
   */
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller already closed (client aborted) — ignore */
        }
      };

      let content = '';
      // The calm closing summary shown in the final bubble (the plan + per-tool
      // actions already streamed live into the feed, so the bubble need not repeat
      // the whole markdown wall). `content` below stays the FULL render for
      // persistence + backward-compat.
      let finalText = '';
      let changes: FileChange[] = [];
      try {
        const result = await runTabAgent({
          user,
          tab: 'software',
          messages: clean,
          extraContext: appContext(app, mode, target),
          // Plan/test/review are read-only — enforced by the harness, not just the prompt.
          toolNames: isReadOnlyMode(mode) ? READ_ONLY_MODE_TOOLS : undefined,
          onPlan: (plan) => send({ type: 'plan', text: plan }),
          onStep: (step) => {
            const line: ActivityLine = toolCallToLine(step);
            // `raw` carries the real tool I/O for the Builders-only "show details"
            // affordance; the client keeps it hidden by default.
            send({ type: 'activity', line, raw: { tool: step.tool, args: step.args, result: step.result } });
          },
        });
        content = renderAssistantText(result);
        finalText = result.finalText;
        // Diff the committed tree after the run (build mode only ever writes).
        if (mode === 'build') changes = diffTrees(before, getSnapshot(app.id));
        // A closing activity line summarizing the real committed changeset.
        const summary = mode === 'build' ? committedSummaryLine(app.name, changes) : null;
        if (summary) send({ type: 'activity', line: { tool: 'commit', text: summary, isError: false } });
      } catch (e) {
        if (e instanceof AssistantNotConfiguredError) {
          content = `(${e.message})`;
        } else {
          content =
            (e as Error).name === 'AbortError'
              ? '(the build assistant is still warming up — the model did not respond in time. Your message is saved; send it again in a few seconds.)'
              : '(build assistant offline — LiteLLM unreachable. Your message is saved under the app; the design decisions and data model are captured on this page.)';
        }
      }

      // Persist the running conversation under the app (home of record).
      const persisted: Msg[] = [...clean, { role: 'assistant', content }];
      try {
        await saveChat(id, user, persisted);
      } catch {
        /* persistence best-effort */
      }

      // Terminal event — backward-compatible payload the client reads for the
      // final assistant bubble + the committed diff. `content` is the full render
      // (persisted); `finalText` is the calm closing line the bubble prefers.
      send({
        type: 'final',
        role: 'assistant',
        content: content || '(no content)',
        finalText: finalText || content || '(no content)',
        model,
        mode,
        changes,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
