/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { modeDirective, type ChatRunMode } from './chat-modes.ts';
import { defineContextBlock, specPromptLines as specLines } from './define-context.ts';
import type { BuildTarget } from './build-target.ts';

/**
 * The per-app BUILD-CHAT prompt assembly, lifted verbatim from the chat route
 * (app/api/apps/[id]/chat/route.ts) so the route keeps only request parse + auth +
 * response shaping. Nothing here changed behaviourally — same brief text, same
 * context ordering, same conditionals.
 */

/**
 * A concise, ACCURATE description of the OS-client SDK surface + the `vite-os`
 * scaffold conventions, injected into the build brief for governed frontend apps
 * (template `vite-os`). It is grounded in the REAL SDK (`lib/app-sdk/client.ts`):
 * every method below exists — do NOT let the model invent others. Data and auth
 * come from the OS over its governed routes, never a custom backend the app ships.
 */
export const OS_SDK_BRIEF = [
  '## This app is a GOVERNED FRONTEND over the OS API (vite-os)',
  'This is a Vite + React + TypeScript + Tailwind + shadcn/ui SPA. It has NO custom',
  'backend and NO database of its own: all data and identity come from the Sovereign',
  'OS over its governed, OPA-checked, RLS/DLS-filtered routes. The app reaches them',
  'ONLY through the OS-client SDK, imported as `@sovereign-os/app-sdk`.',
  '',
  'Do NOT construct a client in a page. Import the ready singleton:',
  "  import { os } from '../../../core/store'   // 3 `../` up from src/epics/<epic>/<story>/",
  'The scaffold creates it ONCE in src/core/store.ts as `createOsClient(APP_SLUG)`, so the app',
  'slug is baked in and `os.records.*` works; the factory in src/os.ts is never called directly.',
  '',
  'The COMPLETE SDK method surface (use ONLY these — do not invent methods):',
  '  os.whoami()                     -> the signed-in principal { user: {...} | null }',
  '  os.context()                    -> granted context: { connections, data, knowledge, files, metrics }',
  '                                     (each an array of { id, name, scope?, folder? })',
  '  os.datasets.list()              -> datasets the user may see',
  '  os.datasets.get(id)             -> one dataset',
  '  os.datasets.query(id, q?)       -> QueryResult. q = { nl } asks a natural-language question that is',
  '                                     answered across ALL of THIS app\'s granted datasets (the `id` is',
  '                                     ignored on the NL path); omit q for a governed row preview of that',
  '                                     ONE dataset id ({ limit }). RAW SQL IS REFUSED (throws UnsupportedQuery).',
  '  os.metrics.list()               -> metrics the user may see',
  '  os.metrics.query(id, q?)        -> QueryResult. slice a metric: q = { dimensions?, timeDimension?, granularity?, filters? }',
  '  os.knowledge.search(q)          -> KnowledgeHit[] from the DLS-scoped knowledge index',
  '  os.files.list()                 -> files the user may see',
  '  os.files.get(id)                -> one file',
  '  os.records.list() · os.records.get(id) · os.records.add(record) · os.records.export()',
  '                                     -> the app\'s OWN governed records (the ONE write door — persisted',
  '                                     durably OS-side, scoped My + Domain; add/export are envelope-gated).',
  '',
  'App-internal / persistent data uses os.records.* — its OWN store. NEVER create OS datasets for the',
  'app\'s own writes: datasets/metrics/knowledge/files are READ-ONLY and creating one fails with a',
  'permission error. os.records.* is the only place the app durably writes.',
  '',
  'ONLY reference dataset ids in the "## Granted context" block. NEVER hard-code a `ds_…` id that is',
  'not granted — an ungranted id fails at runtime (Forbidden) and is flagged at commit + deploy.',
  'DATA IS PRESENT ⇒ BUILD IT: if "## Granted context" lists dataset columns, the data need is MET —',
  'build against those columns. Do NOT refuse or say "the app has no granted data" — the grant is the',
  'authorization (resolved as you, DLS-scoped). Only when NO such block/dataset exists do you stop and',
  'point back to Choose Context (never dead-end).',
  '',
  'QUERY RESULTS ARE A TABLE (do NOT guess the shape). Both os.datasets.query and',
  'os.metrics.query resolve to `QueryResult`:',
  '  interface QueryResult { columns: string[]; rows: string[][]; rowCount: number; answer?: string; sql?: string }',
  'Every cell is a string; `answer`/`sql` are present only on the NL path. Read it directly —',
  'the result is typed, so NO `as` cast and NO `.rows` type-error:',
  "  const r = await os.datasets.query(dsId, { nl: 'how many orders shipped?' });",
  '  const n = Number(r.rows?.[0]?.[0] ?? 0);   // the NL-count pattern',
  '  // r.answer is the grounded sentence; r.columns/r.rows drive a <Table/>.',
  '  const m = await os.metrics.query(metricId, { dimensions: [\'region\'] });',
  '  const firstRegion = m.rows?.[0]?.[0] ?? \'\';         // a metric slice cell',
  '  const firstValue  = Number(m.rows?.[0]?.[1] ?? 0);',
  '',
  'Honesty + errors (from the SDK): a failed governed call throws a typed error —',
  'NotAuthenticated (401), Forbidden (403, carries the server reason), UnsupportedQuery,',
  'or OsError. NEVER catch these and substitute mock/placeholder data: surface the real',
  'state (loading / empty / the error message). Real data or a real error, never a fake.',
  '',
  'Scaffold conventions: entry `src/main.tsx` -> `src/App.tsx`; the client factory lives',
  'in `src/os.ts`. The OS design system is vendored as `@sovereign-os/ui` — its theme is',
  'imported once in `src/index.css` (`@import \'@sovereign-os/ui/theme.css\'`). Build output is',
  '`dist/`, served by nginx on port 8080. Keep imports pointing at `@sovereign-os/app-sdk` +',
  '`@sovereign-os/ui` and follow the existing file layout.',
  '',
  'ONLY 3 import sources exist in a page: `react` (hooks), `@sovereign-os/ui` (the vendored',
  'primitives), and the OS `os` client (`@sovereign-os/app-sdk`, via `../../../core/store`).',
  'NEVER import anything else — no `react-router-dom` / any router, no axios, no 3rd-party UI /',
  'date / query lib. They are NOT installed; the import fails `TS2307` and the commit is REJECTED.',
  'NAVIGATION IS THE SECTION REGISTRY, not a router: a feature is a default-exported page component',
  'in `src/template/sections.tsx`. No `<Link>`, no `useNavigate`, no `<Routes>`. For the default',
  '`sovereign-app` template the OS AUTO-GENERATES sections.tsx on every commit from the pages at',
  'EXACTLY `src/epics/<epic>/<story>/<PascalCase>.tsx` (one page per story folder, filename starts',
  'UPPERCASE, `general/` skipped) — do NOT hand-edit sections.tsx there. (Other templates register',
  'a page by adding its entry to sections.tsx by hand.)',
  '',
  'A STORY/FEATURE PAGE RETURNS ITS CONTENT — `<Section title="…"><Card>…</Card></Section>` — and',
  'NEVER renders `<AppShell>`. `AppShell` is TEMPLATE-ONLY (src/template/shell.tsx already wraps',
  'every section in it, and it REQUIRES a `nav` prop); a page that returns `<AppShell>` fails',
  '`TS2741: Property \'nav\' is missing`. Mirror `src/template/pages/Overview.tsx` exactly.',
  '',
  '"DONE" = status + committed code, NEVER the spec. A story is implemented ONLY if it is marked',
  "status:'done' AND committed files implement it. The acceptance-criteria / spec text says what to",
  'BUILD — it is not proof anything was built. Asked to build a story that is NOT done and has no',
  'files? BUILD IT — never reply "already implemented / no further build needed" or recite the',
  'acceptance criteria as evidence. If unsure, `read_app_files` its src/epics/<epic>/<story>/ path first.',
  '',
  'ROLES & PERMISSIONS — gate on the OS user. `useIdentity()` (src/template/identity.tsx) returns',
  'IdentityState, a DISCRIMINATED UNION with a `.phase` field ({phase:\'loading\'} | {phase:\'signed-out\'}',
  '| {phase:\'error\',message} | {phase:\'ready\',user}). It has NO `id` field.',
  'Narrow first: never `const { id } = useIdentity()`, never `.id`, and never touch `.user` without',
  'narrowing on `identity.phase === \'ready\'` first. Copy this exactly (mirror src/template/pages/Overview.tsx):',
  '  const identity = useIdentity();',
  "  const user = identity.phase === 'ready' ? identity.user : null;",
  "  const canEdit = !!user && roleAtLeast(user.role, 'domain_admin');",
  '`roleAtLeast(user.role, \'<floor>\')` from src/template/roles.ts — NEVER an exact match like',
  '`role === \'admin\'` (it hard-blocks a real admin; ladder: creator < builder < domain_admin < admin;',
  '"admins/managers can X" ⇒ usually \'domain_admin\'). Do NOT invent app roles/permissions. Only gate',
  'when the role is KNOWN; while loading or role null, treat as not-yet-known, not denied. Client checks',
  'are ADVISORY UX — HIDE or DISABLE the control (quiet, friendly), never a scary blocking error; the OS',
  'data layer enforces.',
  '',
  'BADGE COLOUR IS `tone`, NEVER `variant`. `<Badge>` takes an OPTIONAL `tone` prop whose',
  'ONLY allowed values are: default | ok | warn | err | muted. There is NO `variant` prop',
  '(and no `info`/`success`/`error` tones) — using them is a compile error that REJECTS the',
  'commit. Correct: `<Badge tone="ok">Live</Badge>` · `<Badge tone="warn">Pending</Badge>` ·',
  '`<Badge tone="err">Failed</Badge>` · `<Badge>Neutral</Badge>`.',
].join('\n');

/** The app shape the build brief reads (mirrors the chat route's local param type). */
export type BuildBriefApp = {
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
  epics?: {
    id: string;
    title: string;
    stories: {
      id: string;
      title: string;
      asA: string;
      iWant: string;
      soThat: string;
      acceptance: string;
      spec?: { features?: string[]; nfrs?: string[]; rules?: string[] };
    }[];
  }[];
};

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
export function appContext(
  app: BuildBriefApp,
  mode: ChatRunMode,
  target: BuildTarget | null,
  grantedContext: string,
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
        : 'It is a governed app that lives in its own Forgejo repo';
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

  // The REAL granted context (DLS-scoped): the granted datasets' columns, knowledge,
  // metrics, files and connections, so generated code targets the real data plane —
  // exact column names + metric members, never invented. Empty grants ⇒ '' (skipped).
  if (grantedContext) lines.push('', grantedContext);

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
      'To add a feature: create src/epics/<epic>/<story>/<PascalCase>.tsx (one default-exported',
      'page per story folder). The OS auto-generates src/template/sections.tsx from these pages on',
      'every commit — do NOT hand-edit it. Keep template/ intact and the entrypoints thin. See',
      '## Docs for the full skeleton guide and the code-structure convention.',
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
