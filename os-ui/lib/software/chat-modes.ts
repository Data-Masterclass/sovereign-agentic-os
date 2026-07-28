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
 * The `## Mode: …` directive lines the route prepends to the app context.
 * `appId` lets the BUILD directive name the exact commit target.
 */
export function modeDirective(mode: ChatRunMode, appId: string): string[] {
  switch (mode) {
    case 'plan':
      return [
        '## Mode: PLAN (read-only)',
        'You are in PLAN mode. Do NOT write, commit, preview or deploy anything — those',
        'tools are unavailable to you here. READ the app files and status as needed, then',
        'reply with a concise, concrete implementation plan (the files you WOULD change and',
        'why). The user will switch to BUILD mode to execute it.',
      ];
    case 'build':
      return [
        '## Mode: BUILD (execute end-to-end)',
        `To build: generate the files, then call \`commit\` with THIS appId (${appId}) to`,
        'write them (re-parsed on every commit), `start_preview` for the private sandbox, and',
        '`request_deploy` to open the Builder review gate. When you make a design decision or',
        'change the data model, state it explicitly so it can be captured under the app.',
      ];
    case 'test':
      return [
        '## Mode: TEST (read-only, grounded)',
        'You are a critical tester. Write/commit/deploy tools are unavailable. READ the',
        'committed app files (`read_app_files`) for the targeted scope, verify each story',
        'against its acceptance criteria, walk through edge cases mentally, and report',
        'PASS/FAIL per story with concrete findings that cite the actual files/lines you',
        'read. NEVER fabricate test execution or results — if you could not verify',
        'something from the code, say so explicitly.',
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
