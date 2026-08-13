/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * CHAT RUN MODES for the per-app build chat (pure, unit-tested).
 *
 *   • plan   — discuss + draft an implementation plan. Read-only.
 *   • build  — execute end-to-end (commit/preview/deploy tools available).
 *   • test   — act as a critical tester over the COMMITTED code. Read-only.
 *   • review — understand what has been built + surface problems/ideas. Read-only.
 *
 * Read-only is ENFORCED by the harness tool allowlist (not just prompted): a
 * plan/test/review turn cannot mutate the app. Each mode's directive is prepended
 * to the system context by the chat route.
 */

export type ChatRunMode = 'plan' | 'build' | 'test' | 'review';

/** Coerce an arbitrary body value into a valid run mode (default: build). */
export function asChatRunMode(v: unknown): ChatRunMode {
  return v === 'plan' || v === 'build' || v === 'test' || v === 'review' ? v : 'build';
}

/** Every mode except `build` runs on the read-only tool allowlist. */
export function isReadOnlyMode(mode: ChatRunMode): boolean {
  return mode !== 'build';
}

/** The model role each software run mode should resolve to (pure — the tier policy). */
export type SwModelRole = 'reasoning' | 'standard';

/**
 * The MODEL TIER per software run mode (Software tab tier policy). ALL software stages —
 * PLAN (Design spec/plan), BUILD (code generation), TEST (verify each story/feature) and
 * REVIEW — run on the REASONING model. Code generation is reasoning-heavy in practice
 * (getting the vendored SDK/UI surface + governance right in one pass), and the standard
 * model proved too weak for it, so Build is no longer pinned to standard. (An admin
 * per-stage override is planned; until then this is the fixed default.)
 */
export function modelRoleForMode(_mode: ChatRunMode): SwModelRole {
  return 'reasoning';
}

/** A short, honest UI note for the tier a stage runs on. */
export function tierNote(role: SwModelRole): string {
  return role === 'reasoning' ? 'reasoning model' : 'standard model';
}

/**
 * The governed READ-ONLY tool allowlist (list/get software, read the app files,
 * status) shared by plan, test and review runs — no commit/preview/deploy.
 */
export const READ_ONLY_MODE_TOOLS = [
  'whoami',
  'list_capabilities',
  'get_guide',
  'list_software',
  'get_software',
  'read_app_files',
  'get_software_status',
];

/**
 * The BUILD tool allowlist — WRITE-ONLY over a FROZEN context (0.6.108). Build writes code
 * against the schema that Choose Context already froze into the static "## Granted context"
 * block; it does NOT discover or query data. So Build gets the orientation set
 * (READ_ONLY_MODE_TOOLS) PLUS the ONE write door `commit` — and DELIBERATELY excludes the
 * data-discovery/query/design surface (`list_datasets` / `profile_dataset` / `query_data` /
 * `design_software` / `create_dataset` / `start_preview` / `request_deploy`). Those live in
 * Choose Context, where context is bound/created — handing them to Build made the model wander,
 * re-query and dead-end mid-build on "no granted dataset" instead of just writing the code.
 *
 * `get_dataset` is KEPT here as a deliberate fallback: the injected column schema carries
 * names + descriptions but NO per-column SQL type (ColumnDoc has no type field — see
 * lib/data/dataset-schema.ts; only measures carry a type), so the build model can still fetch
 * a granted dataset's full detail when it needs the exact column type. It is scoped to the
 * app's own grants, so this is not a discovery back-door.
 */
export const BUILD_MODE_TOOLS = [...READ_ONLY_MODE_TOOLS, 'get_dataset', 'commit'];

/**
 * BUILD PRINCIPLES — five one-line rules, aligned 1:1 with the five TEST dimensions
 * (Functionality · User Experience · Code Structure · Security · Documentation). Injected
 * into the BUILD and Design spec-drafting prompts so what we build is what we later verify.
 * Kept terse on purpose — this rides in every build turn, so it must not bloat context.
 */
export const BUILD_PRINCIPLES = [
  '1. Functionality — deliver every feature/NFR/rule in the story spec; real data or a real error, never a fake.',
  '2. User Experience — honest loading/empty/error states, OS chrome + primitives, no dead ends.',
  '3. Code Structure — implementations under src/template/·src/core/·src/epics/<epic>/<story>/; src/main.tsx+src/App.tsx stay thin entrypoints.',
  '4. Security — respect OS identity + My/Domain scope; stamp owner+domain on write, never widen visibility client-side.',
  '5. Documentation — comment non-obvious logic and record design decisions so the code explains itself.',
].join('\n');

/**
 * The generated-app CODE STRUCTURE convention — the folder layout every build must honor.
 * It mirrors the epic/story spec so code maps 1:1 to the backlog. The default template
 * (`sovereign-app`) is a VITE + React + TS SPA: everything lives under `src/`, and
 * `src/main.tsx`+`src/App.tsx` are the THIN entrypoints that mount the template Shell —
 * there is NO Next.js `app/` directory.
 */
export const CODE_STRUCTURE_CONVENTION = [
  '## Generated-app code structure (honor this on every build)',
  'This is a Vite + React + TypeScript SPA — ALL code lives under `src/`. Organize it to',
  'mirror the epic/story spec. Real logic lives in structured folders; the two entrypoints',
  '(`src/main.tsx` → `src/App.tsx`) stay thin and only mount the template Shell.',
  '',
  '  src/template/                 FIXED scaffold: identity, roles, scope, admin shell,',
  '                                the AppShell layout + section registry. Do NOT change',
  '                                unless a developer overrides it.',
  '  src/core/                     Overarching custom functionality + SHARED backend/data',
  '                                (store, utils, shared components). The default Sovereign',
  '                                app uses the GOVERNED DATA PLANE (OS SDK).',
  '  src/epics/<epicKey>/general/  Epic-wide shared code (used by ≥2 stories of the epic).',
  '  src/epics/<epicKey>/<storyKey>/  THAT story\'s feature code + its own backend/data.',
  '  src/main.tsx, src/App.tsx     THIN entrypoints ONLY — they boot React and mount the',
  '                                template Shell. No business logic here.',
  '',
  'RULES: write each story\'s implementation under src/epics/<epic>/<story>/; put anything',
  'shared across stories in src/core/ (or src/epics/<epic>/general/ if epic-local). Never put',
  'real logic in the entrypoints — keep src/main.tsx + src/App.tsx thin and src/template/ intact.',
  '',
  '## Generated-app API contract — the tiny surface that exists (breaking it FAILS the compile gate)',
  'There are ONLY 3 import sources in a story/feature page. Import from nothing else:',
  "  1. `react`               — hooks only (useState, useEffect, useCallback, …).",
  "  2. `@sovereign-os/ui`    — the vendored primitives (exact list below).",
  "  3. `../../../core/store` — the ready OS client singleton `os` ({ os } — 3 `../` up from",
  '                             src/epics/<epic>/<story>/ to src/core/store).',
  'NEVER import anything else — no `react-router-dom` / any router, no axios/fetch-wrapper, no 3rd-party',
  'UI / date / query / chart lib. They are NOT installed; the import fails `TS2307 Cannot find module` and',
  'the commit is REJECTED. (Live failure seen: `import { useNavigate } from \'react-router-dom\'`.)',
  '',
  '## The `os` client — use the SLUG-BOUND SINGLETON, never construct one in a page:',
  "  import { os } from '../../../core/store'   // 3 `../` up from src/epics/<epic>/<story>/",
  'The scaffold creates it ONCE in src/core/store.ts as `createOsClient(APP_SLUG)`, so the app',
  'slug is baked in and `os.records.*` works. Do NOT call `createOsClient` yourself in a page — a',
  'client built without the slug throws on every os.records.* call. The factory in src/os.ts is',
  'internal to the scaffold and is never called directly from feature code.',
  '',
  'NAVIGATION = the section registry, NOT a router. A feature is just a DEFAULT-exported page component under',
  'src/epics/<epic>/<story>/; the OS auto-registers it into src/template/sections.tsx (see below). There is',
  'no client-side router: no `<Link>`, no `useNavigate`, no `<Routes>`/`<Route>`.',
  '',
  'A STORY PAGE RETURNS ITS CONTENT — `<Section title="…"><Card>…</Card></Section>` — and NEVER renders',
  '`<AppShell>`. The template shell (src/template/shell.tsx) already wraps every section in AppShell; a page',
  'that returns `<AppShell>…</AppShell>` fails `TS2741: Property \'nav\' is missing` and is REJECTED. Mirror',
  'the shape of src/template/pages/Overview.tsx exactly. (Live failure seen: a page wrapped in <AppShell>.)',
  '',
  '## UI primitives — import ONLY these from `@sovereign-os/ui` (nothing else is exported):',
  '  AppShell · Button · Card · Badge · Input · Textarea · Select · Table · Section · Panel · Alert · Spinner · cx',
  'Importing any component NOT in this list (Modal, Dialog, Tabs, Tooltip, Grid, Flex, Icon, …) makes the',
  'build FAIL to compile — compose from the primitives above or plain HTML/CSS instead. EXACT signatures',
  '(props not listed are the native HTML element\'s — Section/Card/Table/Panel are div/table wrappers):',
  '  • `<AppShell nav={…} …>` — TEMPLATE-ONLY; it REQUIRES `nav` (NavItem[]). NEVER use it in a page.',
  '  • `<Section title="…">…</Section>` — the page\'s top-level block (`title` optional). Card/Panel wrap content.',
  '  • `<Alert variant="info|success|warning|error">…</Alert>` for notices/errors; `<Spinner />` while loading.',
  '  • `<Badge tone="default|ok|warn|err|muted">` — tone, NEVER `variant` (Badge has no `variant`/`info` tone).',
  '  • `<Button variant="primary|ghost" size="md|sm" onClick={…}>` — primary is the default.',
  '  • `<Input value={v} onChange={e => …}/>` (controlled text) and `<Textarea rows={3} …/>` for multi-line —',
  '    NOT `<Input as="textarea">`.',
  '  • `<Select value={v} onChange={e => …}>` renders a native <select>: pass `<option value=…>` CHILDREN',
  '    (no `options=` prop).',
  '  • `<Table><thead/><tbody/></Table>` — compose the usual table rows inside.',
  'EVENT HANDLERS: the vendored Input/Select/Textarea forward native props, so `onChange` is already typed —',
  'read `e.currentTarget.value` (no `as` cast needed; mirror src/template/pages/Admin.tsx).',
  '',
  '## Story pages are AUTO-REGISTERED (sovereign-app only) — just write the page:',
  'For the default `sovereign-app` template, create each story page at EXACTLY',
  '`src/epics/<epic>/<story>/<PascalCase>.tsx` (depth 4, filename starts UPPERCASE) with a',
  'DEFAULT-exported React component. The OS regenerates `src/template/sections.tsx` from these',
  'page files on every commit, so the page appears in the nav automatically — do NOT hand-edit',
  'sections.tsx (it is auto-generated and your edits are overwritten). Discovery rules: ONE',
  'PascalCase page per story folder becomes one nav section (a 2nd page in the same folder is',
  'ignored); a lowercase-first filename (e.g. `index.tsx`) is NOT registered; the `general/`',
  'folder is skipped (put shared/helper code there or in a nested subfolder).',
].join('\n');

/**
 * The TRUE governed data plane the app SDK exposes — reads AND the one real write
 * surface. Replaces the weeks of hallucinated `os.datasets.update` / `os.files.create`
 * (no such methods exist; those commits are rejected TS2339 by the compile gate).
 */
export const DATA_PLANE_CONTRACT = [
  '## Governed data plane — the ONLY `os` methods that exist (anything else fails the compile gate)',
  'Import the shared client once, then call it from your story code:',
  "  import { os } from '../../../core/store'   // exact depth from src/epics/<epic>/<story>/ (3 up, then core/store)",
  '',
  'READS (always available, run as the signed-in user under OPA + RLS/DLS):',
  '  • os.datasets.list() · os.datasets.get(id) · os.datasets.query(id, { nl })   // datasets are READ-ONLY',
  '  • os.metrics.list()  · os.metrics.query(id, { dimensions, granularity })',
  '  • os.knowledge.search(q) · os.files.list() · os.files.get(id) · os.whoami() · os.context()',
  'WRITES — the ONE write surface is os.records.* (the app\'s OWN records), and ONLY these:',
  '  • os.records.list() · os.records.get(id) · os.records.add(record) · os.records.export()',
  '  add/export run live ONLY when this app\'s APPROVED deploy envelope permits them; otherwise the OS',
  '  answers 403 and the SDK throws Forbidden with the reason. There is NO os.datasets.update, no',
  '  os.files.create, no os.knowledge.write — datasets/metrics/knowledge/files are reads. Do not invent methods.',
  '  ALL app-internal / persistent data goes through os.records.* (the app\'s OWN governed store, persisted',
  '  durably OS-side). NEVER create an OS dataset for the app\'s own writes — datasets are read-only and it fails.',
  '',
  'GROUND RULES — this app can only reach the artifacts in its grants (see "## Granted context"):',
  '  • The granted dataset SCHEMA above is AUTHORITATIVE over the story-spec field names: if the',
  '    spec mentions fields the schema lacks (status, tenant, SKU, …), do NOT invent them — build with',
  '    the real columns and note the gap in your result.',
  '  • os.datasets.query AND os.metrics.query resolve to a typed `QueryResult`:',
  '    { columns: string[]; rows: string[][]; rowCount: number; answer?; sql? } — rows are ARRAYS in',
  '    column order (do NOT assume object keys). Read a scalar as `Number(r.rows?.[0]?.[0] ?? 0)` — no cast.',
  '  • os.datasets.query(id, { nl }) routes to the ask surface, which is scoped to THIS app\'s granted',
  '    datasets ONLY; a natural-language query about anything else is refused.',
  '  • Never call list routes expecting the user\'s full catalog — the app sees only its grants.',
  '  • ONLY reference the dataset ids in "## Granted context" above. NEVER hard-code a `ds_…` id that',
  '    is not in that granted list — an ungranted id fails at runtime (Forbidden) and is flagged at',
  '    commit + deploy. Have no granted dataset? Ask for the grant; do not invent an id.',
  '',
  'A gate rejection lists errors across ALL files in the merged tree — fix EVERY listed file, not only',
  'the one you just wrote, then re-commit.',
].join('\n');

/**
 * The `## Mode: …` directive lines the route prepends to the app context.
 * `appId` lets the BUILD directive name the exact commit target.
 */
export function modeDirective(mode: ChatRunMode, appId: string): string[] {
  switch (mode) {
    case 'plan':
      return [
        '## Mode: PLAN (read-only — Design spec drafting)',
        'You are in PLAN mode. Do NOT write, commit, preview or deploy anything — those',
        'tools are unavailable to you here. READ the app files and status as needed, then',
        'reply with a concise, concrete implementation plan (the files you WOULD change and',
        'why). The user will switch to BUILD mode to execute it.',
        '',
        'Draft the spec/plan against the BUILD PRINCIPLES it will be built and verified by:',
        BUILD_PRINCIPLES,
        '',
        'Place planned files per the code-structure convention (implementations under',
        'src/template/·src/core/·src/epics/<epic>/<story>/; src/main.tsx+src/App.tsx = thin entrypoints only).',
      ];
    case 'build':
      return [
        '## Mode: BUILD (write code against the frozen granted context)',
        'Context (datasets, knowledge, metrics, connections) was bound or created earlier in',
        'CHOOSE CONTEXT; its schema is already injected below as "## Granted context". BUILD',
        'WRITES CODE against that frozen schema — do NOT discover, list or query data here (those',
        'tools live in Choose Context, not Build).',
        'DATA IS PRESENT ⇒ BUILD IT. If a "## Granted context" block WITH dataset columns appears',
        'below, the data need is ALREADY MET — you MUST build against those columns. Do NOT refuse,',
        'stall, or claim "the app has no dataset / no granted data" — that block IS the grant, it',
        'was resolved AS you (DLS-scoped). Reasoning yourself into "I should not read this data" is',
        'a bug: the grant is the authorization. ONLY when there is genuinely NO "## Granted context"',
        'block (or it lists no dataset the story needs) do you stop — and then say in ONE line "go to',
        'Choose Context and bind or create the dataset for this story," never dead-end. Never invent',
        'an id or wander looking for data.',
        '',
        `To build: generate the files, then call \`commit\` with THIS appId (${appId}) to`,
        'write them (re-parsed on every commit), `start_preview` for the private sandbox, and',
        '`request_deploy` to open the Builder review gate. When you make a design decision or',
        'change the data model, state it explicitly so it can be captured under the app.',
        '',
        'COMMIT SIGNATURE — the file source goes in the `files` array, NOT in your prose. The',
        'server only writes what `files` carries; text in your reply is never committed. Exact shape:',
        '  commit({ files: [{ path: "src/epics/<epic>/<story>/Page.tsx", content: "<full file source>" }] })',
        'The appId is bound automatically — never pass an empty commit. A story counts as BUILT',
        'only once its files land in a SUCCESSFUL commit — never claim a story is done from a',
        'reply alone. If you cannot commit this turn, do NOT write a step-by-step "here is the',
        'plan you can run" essay pretending to be a deliverable: say plainly in ONE line that the',
        'build did not land and why, so the turn is honestly marked failed and can be retried.',
        'Commits are COMPILE-CHECKED server-side: a commit that does not compile is rejected with',
        'the exact diagnostics (file:line + TS code) and nothing is written — fix them and',
        're-commit; never end the turn with known-red diagnostics. If a commit is REJECTED, FIX',
        'those exact diagnostics before re-committing — never resubmit the same unchanged code (an',
        'identical rejected commit just loops).',
        '',
        '"DONE" IS GROUNDED IN FACTS, NEVER IN THE SPEC. A story counts as implemented ONLY if it is',
        "marked status:'done' AND committed source files implement it (visible in the file tree /",
        '`read_app_files`). The acceptance-criteria / spec text says what to BUILD — it is NOT evidence',
        'that anything was built. So when asked to build a story that is NOT marked done and has no',
        'implementing files, BUILD IT — never reply "already implemented / committed / live / no further',
        'build needed" and never recite the acceptance criteria back as proof. Restating the spec is not',
        'a build. If unsure whether code exists, `read_app_files` the story\'s src/epics/<epic>/<story>/',
        'path first, then build what is missing.',
        '',
        'ROLES & PERMISSIONS — use the scaffolded helpers, never invent a check. `useIdentity()`',
        '(src/template/identity.tsx) returns IdentityState, a DISCRIMINATED UNION with a `.phase` field',
        "({phase:'loading'} | {phase:'signed-out'} | {phase:'error',message} | {phase:'ready',user}). It has",
        'NO `id` field — never `const { id } = useIdentity()`, never `.id`, and never touch `.user` without',
        "narrowing on `.phase === 'ready'` first. Copy this exactly (mirror src/template/pages/Overview.tsx):",
        '  const identity = useIdentity();',
        "  const user = identity.phase === 'ready' ? identity.user : null;",
        "  const canEdit = !!user && roleAtLeast(user.role, 'domain_admin');",
        "Gate with `roleAtLeast(user.role, '<floor>')` from src/template/roles.ts — NEVER an exact match like",
        "`role === 'admin'` (that wrongly EXCLUDES higher roles and hard-blocks a real admin). The OS",
        'ladder is creator < builder < domain_admin < admin; map story language ("admins/managers can X")',
        "to `roleAtLeast(user.role, 'domain_admin')` (or 'builder' for a lighter gate). Do NOT invent",
        "app roles/permissions ('manager', 'Assign-Case permission') — they do not exist in the OS. Only",
        "gate when the role is KNOWN (phase 'ready'); while loading, or when role is null, treat it as",
        'not-yet-known, NOT denied — never hard-fail. Client checks are ADVISORY UX: HIDE or DISABLE the',
        'control for users who lack the role (a quiet, friendly state), never a scary blocking error —',
        'real enforcement is the OS data layer (OPA on the governed data plane); the JS gate is a courtesy.',
        '',
        'Build to these PRINCIPLES (they map 1:1 to how Test verifies you):',
        BUILD_PRINCIPLES,
        '',
        CODE_STRUCTURE_CONVENTION,
        '',
        DATA_PLANE_CONTRACT,
      ];
    case 'test':
      return [
        '## Mode: TEST (read-only, grounded — 5-dimension verification)',
        'You are the critical verifier. Write/commit/deploy tools are unavailable. READ the',
        'COMMITTED app files (`read_app_files`) for the targeted scope and verify the code',
        'against the spec, top-down: epics → stories → features → NFRs → rules.',
        '',
        'Verify across these FIVE named dimensions, reporting PASS or FAIL for EACH:',
        '  • Functionality  — every feature/NFR/rule in the spec is actually implemented; real data or a real error, never a fake.',
        '  • User Experience — honest loading/empty/error states, OS chrome + primitives, no dead ends.',
        '  • Code Structure  — logic lives under src/template/·src/core/·src/epics/<epic>/<story>/; src/main.tsx+src/App.tsx are thin entrypoints only.',
        '  • Security        — OS identity respected, My/Domain scoping enforced (owner+domain stamped, visibility never widened).',
        '  • Documentation   — non-obvious logic is commented and design decisions are recorded.',
        '',
        'For EACH dimension give a PASS/FAIL verdict with concrete findings that CITE the',
        'actual files/lines you read. Every shortfall becomes ONE improvement TAGGED with its',
        'dimension (functionality | ux | code | security | docs).',
        'NEVER fabricate test execution or results — if you could not verify something',
        'from the code, say so.',
      ];
    case 'review':
      return [
        '## Mode: REVIEW (read-only, grounded)',
        'You are reviewing what has been built. Write/commit/deploy tools are unavailable.',
        'READ the committed app files (`read_app_files`) for the targeted scope, then:',
        'summarize the implemented functionality file-by-file, flag risks or problems, and',
        'propose 3-5 concrete improvement or feature ideas. Ground every statement in the',
        'files you actually read — never invent functionality that is not in the code.',
      ];
  }
}
