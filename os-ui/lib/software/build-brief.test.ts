/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * build-brief — the per-app BUILD-CHAT prompt assembly (OS_SDK_BRIEF + appContext),
 * lifted verbatim from the chat route. These pin the load-bearing conditionals so
 * the move stays behaviour-preserving: the SDK brief only appears for governed
 * frontends, the skeleton contract only for sovereign-app, and story/epic targeting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appContext, OS_SDK_BRIEF, type BuildBriefApp } from './build-brief.ts';

function baseApp(overrides: Partial<BuildBriefApp> = {}): BuildBriefApp {
  return {
    id: 'app_1',
    name: 'Demo',
    template: 'vite-os',
    subdomain: 'demo.example',
    repo: { fullName: 'org/demo' },
    designDecisions: '',
    dataDescriptions: '',
    docs: '',
    ...overrides,
  };
}

test('governed frontend gets the OS SDK brief; api-service does not', () => {
  const gf = appContext(baseApp({ template: 'vite-os' }), 'build', null, '');
  assert.ok(gf.includes(OS_SDK_BRIEF), 'vite-os includes the SDK brief');
  const api = appContext(baseApp({ template: 'api-service' }), 'build', null, '');
  assert.ok(!api.includes(OS_SDK_BRIEF), 'api-service omits the SDK brief');
  assert.match(api, /APIs-only service/, 'api-service stack line');
});

test('the SDK brief teaches the REAL Badge `tone` API and the QueryResult query shape', () => {
  // Badge: `tone` with the real allowed values, and an explicit "never variant".
  assert.match(OS_SDK_BRIEF, /`tone`, NEVER `variant`/, 'brief names tone-not-variant');
  assert.match(OS_SDK_BRIEF, /default \| ok \| warn \| err \| muted/, 'brief lists the REAL allowed tones');
  assert.match(OS_SDK_BRIEF, /<Badge tone="ok">/, 'brief shows a correct copy-pasteable Badge');
  // It must NOT teach a tone that does not exist on the real Badge (honesty).
  assert.ok(!/tone="info"/.test(OS_SDK_BRIEF), 'brief never invents an "info" tone');
  // QueryResult: the shape + the exact scalar-read pattern the failing app tried.
  assert.match(OS_SDK_BRIEF, /QueryResult/, 'brief names the QueryResult type');
  assert.match(OS_SDK_BRIEF, /columns: string\[\]; rows: string\[\]\[\]; rowCount: number/, 'brief states the shape');
  assert.match(OS_SDK_BRIEF, /Number\(r\.rows\?\.\[0\]\?\.\[0\] \?\? 0\)/, 'brief shows the NL-count pattern (no cast)');
});

test('the SDK brief forbids the two live compile-gate failures: react-router-dom + <AppShell> in a page', () => {
  // Failure 1: `import { useNavigate } from 'react-router-dom'` — there is no router.
  assert.match(OS_SDK_BRIEF, /react-router-dom/, 'brief names the banned router import that bit us');
  assert.match(OS_SDK_BRIEF, /not a router|any router|no (client-side )?router/i, 'brief states there is no router');
  assert.match(OS_SDK_BRIEF, /ONLY 3 import sources/i, 'brief names the three allowed import sources');
  // Failure 2: a page wrapped its content in <AppShell> (TS2741 nav missing).
  assert.match(OS_SDK_BRIEF, /NEVER renders?\s+`?<AppShell>/i, 'brief forbids rendering AppShell in a page');
  assert.match(OS_SDK_BRIEF, /template[- ]only/i, 'brief says AppShell is the template shell\'s job');
});

test('the SDK brief forbids the false "already implemented" refusal — done = status + committed code, not spec', () => {
  assert.match(OS_SDK_BRIEF, /"DONE" = status \+ committed code/i, 'brief defines done by facts, not spec');
  assert.match(OS_SDK_BRIEF, /already implemented/i, 'brief names the exact false refusal to avoid');
  assert.match(OS_SDK_BRIEF, /BUILD IT/, 'brief tells the agent to build an un-built story');
});

test('the SDK brief teaches the REAL role gate — useIdentity + roleAtLeast, not an exact-match block', () => {
  assert.match(OS_SDK_BRIEF, /useIdentity\(\)/, 'brief gets the user from useIdentity');
  assert.match(OS_SDK_BRIEF, /roleAtLeast\(user\.role/, 'brief gates with the roleAtLeast floor helper');
  assert.match(OS_SDK_BRIEF, /role === 'admin'/, 'brief names the exact-match anti-pattern to avoid');
  assert.match(OS_SDK_BRIEF, /creator < builder < domain_admin < admin/, 'brief states the OS role ladder');
  assert.match(OS_SDK_BRIEF, /ADVISORY UX/i, 'client checks are advisory (hide/disable), not enforcement');
});

test('sovereign-app adds the skeleton contract; others do not', () => {
  const sov = appContext(baseApp({ template: 'sovereign-app' }), 'build', null, '');
  assert.match(sov, /Sovereign standard app — skeleton contract/);
  const vite = appContext(baseApp({ template: 'vite-os' }), 'build', null, '');
  assert.ok(!vite.includes('skeleton contract'), 'vite-os has no skeleton contract');
});

test('granted context is included only when non-empty', () => {
  const marker = 'GRANTED_CTX_MARKER_XYZ';
  const withCtx = appContext(baseApp(), 'build', null, marker);
  assert.ok(withCtx.includes(marker), 'non-empty granted context is injected');
  const without = appContext(baseApp(), 'build', null, '');
  assert.ok(!without.includes(marker), 'empty granted context is skipped');
});

test('story target scopes the brief to that one story', () => {
  const app = baseApp({
    epics: [
      {
        id: 'e1',
        title: 'Epic One',
        stories: [
          { id: 's1', title: 'Story One', asA: 'user', iWant: 'x', soThat: 'y', acceptance: 'done' },
        ],
      },
    ],
  });
  const out = appContext(app, 'build', { kind: 'story', epicId: 'e1', storyId: 's1' }, '');
  assert.match(out, /## Target story/);
  assert.match(out, /Story: Story One/);
  assert.match(out, /Acceptance: done/);
});

test('always closes with design/data/docs sections (defaults when empty)', () => {
  const out = appContext(baseApp(), 'build', null, '');
  assert.match(out, /## Design decisions\n\(none yet\)/);
  assert.match(out, /## Data descriptions\n\(none yet\)/);
  assert.match(out, /## Docs\n\(none yet\)/);
});
