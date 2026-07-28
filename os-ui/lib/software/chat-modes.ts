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
 * The MODEL TIER per software run mode (Software tab tier policy). Reasoning is used in
 * exactly the reasoning-heavy places — PLAN (the Design spec/plan drafting + design
 * conversation), TEST (verify each story/feature against its spec) and REVIEW (reason
 * about what shipped). BUILD — the actual code GENERATION — stays STANDARD: the whole
 * point is the standard model does the bulk file writing; codegen is never auto-escalated
 * to reasoning. (The batch build's plan/sequence + built-vs-pending verification are the
 * reasoning-shaped work; they live in Design/Test which are pinned to reasoning.)
 */
export function modelRoleForMode(mode: ChatRunMode): SwModelRole {
  return mode === 'build' ? 'standard' : 'reasoning';
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
 * BUILD PRINCIPLES — five one-line rules, aligned 1:1 with the five TEST dimensions
 * (Functionality · User Experience · Code Structure · Security · Documentation). Injected
 * into the BUILD and Design spec-drafting prompts so what we build is what we later verify.
 * Kept terse on purpose — this rides in every build turn, so it must not bloat context.
 */
export const BUILD_PRINCIPLES = [
  '1. Functionality — deliver every feature/NFR/rule in the story spec; real data or a real error, never a fake.',
  '2. User Experience — honest loading/empty/error states, OS chrome + primitives, no dead ends.',
  '3. Code Structure — implementations under template/·core/·epics/<epic>/<story>/; app/ stays thin router entrypoints.',
  '4. Security — respect OS identity + My/Domain scope; stamp owner+domain on write, never widen visibility client-side.',
  '5. Documentation — comment non-obvious logic and record design decisions so the code explains itself.',
].join('\n');

/**
 * The generated-app CODE STRUCTURE convention — the folder layout every build must honor.
 * It mirrors the epic/story spec so code maps 1:1 to the backlog, while keeping the app a
 * valid Next.js App-Router build (pages/route handlers MUST live under `app/`, so `app/`
 * stays a THIN router layer that imports the real logic from the structured folders).
 */
export const CODE_STRUCTURE_CONVENTION = [
  '## Generated-app code structure (honor this on every build)',
  'Organize code to mirror the epic/story spec. Real logic lives in structured folders;',
  '`app/` holds only thin Next.js App-Router entrypoints that import from them.',
  '',
  '  template/                     FIXED scaffold: identity, roles, scope, admin shell,',
  '                                layout. Do NOT change unless a developer overrides it.',
  '  core/                         Overarching custom functionality + SHARED backend/data',
  '                                (store, utils, shared components). The default Sovereign',
  '                                app uses the GOVERNED DATA PLANE (OS SDK), not Supabase.',
  '  epics/<epicKey>/general/      Epic-wide shared code (used by ≥2 stories of the epic).',
  '  epics/<epicKey>/<storyKey>/   THAT story\'s feature code + its own backend/data.',
  '  app/                          THIN entrypoints ONLY — pages + route handlers that',
  '                                import implementations from template/·core/·epics/…',
  '',
  'RULES: write each story\'s implementation under epics/<epic>/<story>/; put anything shared',
  'across stories in core/ (or epics/<epic>/general/ if epic-local). Never put real logic in',
  'app/ — only a page/handler that renders/calls the structured implementation. Keep template/',
  'intact.',
  '',
  '## UI primitives — import ONLY these from `@sovereign-os/ui` (nothing else is exported):',
  '  AppShell · Button · Card · Badge · Input · Textarea · Select · Table · Section · Panel · Alert · Spinner · cx',
  'Importing any component NOT in this list (Modal, Dialog, Tabs, Tooltip, Grid, Flex, Icon, …) makes the',
  'build FAIL to compile — compose from the primitives above or plain HTML/CSS instead. Correct usage:',
  '  • `<Alert variant="info|success|warning|error">…</Alert>` for notices/errors; `<Spinner />` while loading.',
  '  • Multi-line text is `<Textarea rows={3} …/>` — NOT `<Input as="textarea">`.',
  '  • `<Select>` renders a native <select>: pass `<option value=…>` CHILDREN (no `options=` prop).',
  '',
  '## Story pages are AUTO-REGISTERED — just write the page:',
  'Create each story page as `src/epics/<epic>/<story>/<Name>.tsx` with a DEFAULT-exported React component.',
  'The OS regenerates `src/template/sections.tsx` from these page files on every commit, so the page appears',
  'in the nav automatically — do NOT hand-edit sections.tsx (the generated registry overwrites your edits).',
  'One page component per story folder becomes one nav section (its label is the story-folder name); shared or',
  'helper code goes in `epics/<epic>/general/` or a nested subfolder so it is not mistaken for a page.',
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
        'template/·core/·epics/<epic>/<story>/; app/ = thin router entrypoints only).',
      ];
    case 'build':
      return [
        '## Mode: BUILD (execute end-to-end)',
        `To build: generate the files, then call \`commit\` with THIS appId (${appId}) to`,
        'write them (re-parsed on every commit), `start_preview` for the private sandbox, and',
        '`request_deploy` to open the Builder review gate. When you make a design decision or',
        'change the data model, state it explicitly so it can be captured under the app.',
        '',
        'Build to these PRINCIPLES (they map 1:1 to how Test verifies you):',
        BUILD_PRINCIPLES,
        '',
        CODE_STRUCTURE_CONVENTION,
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
        '  • Code Structure  — logic lives under template/·core/·epics/<epic>/<story>/; app/ is thin router entrypoints only.',
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
