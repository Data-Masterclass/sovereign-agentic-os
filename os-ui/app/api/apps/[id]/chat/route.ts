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

export const dynamic = 'force-dynamic';

type Msg = { role: 'user' | 'assistant'; content: string };
type BuildMode = 'plan' | 'build';
/** A story the Build run is targeting (from the Design EPIC/story selector). */
type BuildStory = { epicId: string; storyId: string; label?: string };

/**
 * PLAN mode = discuss + plan with ZERO code changes: the agent may only READ
 * (list/get software, read the app files, status) — no commit/preview/deploy. The
 * allowlist is enforced by the harness (not just prompted), so a Plan turn cannot
 * mutate the app. BUILD mode leaves the full software tool set in place.
 */
const PLAN_MODE_TOOLS = [
  'whoami',
  'list_capabilities',
  'get_guide',
  'list_software',
  'get_software',
  'read_app_files',
  'get_software_status',
];

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
  'in `src/os.ts`; shadcn primitives under `src/components/ui/`; `cn()` in `src/lib/utils.ts`;',
  'Tailwind via `src/index.css`. Build output is `dist/`, served by nginx on port 8080.',
  'Keep imports pointing at `@sovereign-os/app-sdk` and follow the existing file layout.',
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
    template: string;
    subdomain: string;
    repo: { fullName: string };
    designDecisions: string;
    dataDescriptions: string;
    docs: string;
    epics?: { id: string; title: string; stories: { id: string; title: string; asA: string; iWant: string; soThat: string; acceptance: string }[] }[];
  },
  mode: BuildMode,
  story: BuildStory | null,
): string {
  const isViteOs = app.template === 'vite-os';
  const stackLine = isViteOs
    ? 'It is a Vite + React governed OS-frontend app that lives in its own Forgejo repo'
    : 'It is a Next.js + Supabase app that lives in its own Forgejo repo';
  const lines = [
    `You are the build assistant for the "${app.name}" application (appId: ${app.id}).`,
    stackLine,
    `(${app.repo.fullName}) and ships via Forgejo Actions → Harbor → Argo CD to`,
    `${app.subdomain}.`,
  ];

  // Governed-frontend apps talk to the OS only through the OS-client SDK — teach
  // the harness the real SDK surface + scaffold conventions so generated code is
  // grounded (never invents methods, never fabricates data).
  if (isViteOs) {
    lines.push('', OS_SDK_BRIEF);
  }

  if (mode === 'plan') {
    lines.push(
      '',
      '## Mode: PLAN (read-only)',
      'You are in PLAN mode. Do NOT write, commit, preview or deploy anything — those',
      'tools are unavailable to you here. READ the app files and status as needed, then',
      'reply with a concise, concrete implementation plan (the files you WOULD change and',
      'why). The user will switch to BUILD mode to execute it.',
    );
  } else {
    lines.push(
      '',
      '## Mode: BUILD (execute end-to-end)',
      `To build: generate the files, then call \`commit\` with THIS appId (${app.id}) to`,
      'write them (re-parsed on every commit), `start_preview` for the private sandbox, and',
      '`request_deploy` to open the Builder review gate. When you make a design decision or',
      'change the data model, state it explicitly so it can be captured under the app.',
    );
  }

  if (story) {
    const epic = app.epics?.find((e) => e.id === story.epicId);
    const st = epic?.stories.find((s) => s.id === story.storyId);
    if (st) {
      lines.push(
        '',
        '## Target story (implement THIS story)',
        `EPIC: ${epic?.title || '(untitled)'}`,
        `Story: ${st.title || '(untitled)'}`,
        `As a ${st.asA || '…'}, I want ${st.iWant || '…'}, so that ${st.soThat || '…'}.`,
        st.acceptance ? `Acceptance: ${st.acceptance}` : '',
        'Focus this turn on delivering exactly this story.',
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
  let mode: BuildMode = 'build';
  let story: BuildStory | null = null;
  try {
    const body = await req.json();
    messages = Array.isArray(body?.messages) ? body.messages : [];
    if (body?.mode === 'plan' || body?.mode === 'build') mode = body.mode;
    if (body?.story && typeof body.story.epicId === 'string' && typeof body.story.storyId === 'string') {
      story = { epicId: body.story.epicId, storyId: body.story.storyId, label: typeof body.story.label === 'string' ? body.story.label : undefined };
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

  let content = '';
  let changes: FileChange[] = [];
  const model = roleModel('standard');
  try {
    const result = await runTabAgent({
      user,
      tab: 'software',
      messages: clean,
      extraContext: appContext(app, mode, story),
      // PLAN mode is read-only — enforced by the harness, not just the prompt.
      toolNames: mode === 'plan' ? PLAN_MODE_TOOLS : undefined,
    });
    content = renderAssistantText(result);
    // Diff the committed tree after the run (build mode only ever writes).
    if (mode === 'build') changes = diffTrees(before, getSnapshot(app.id));
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

  return NextResponse.json({ role: 'assistant', content: content || '(no content)', model, mode, changes });
}
