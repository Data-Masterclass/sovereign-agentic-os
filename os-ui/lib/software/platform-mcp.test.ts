/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { callPlatformMcp, platformMcpToolNames, PLATFORM_MCP_TOOLS } from './platform-mcp.ts';
import type { App } from '@/lib/software/apps';
import type { DeployRequestResult } from './review.ts';

const creator: CurrentUser = { id: 'dan', name: 'Dan', domains: ['sales'], role: 'creator' };
const builder: CurrentUser = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' };

async function expectStatus(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e: Error & { status?: number }) => {
    assert.equal(e.status, status);
    return true;
  });
}

test('INVARIANT: Platform MCP has UI parity — create→preview→request_deploy work for the creator', async () => {
  const app = (await callPlatformMcp(creator, 'create_software', {
    name: 'MCP Renewals',
    template: 'nextjs-supabase',
  })) as App;
  assert.ok(app.id);
  // startPreview now returns { app, runnerNote } so the MCP result is that shape.
  const previewResult = (await callPlatformMcp(creator, 'start_preview', { appId: app.id })) as { app: App; runnerNote: string | null };
  assert.equal(previewResult.app.deploy.state, 'preview');

  const res = (await callPlatformMcp(creator, 'request_deploy', { appId: app.id })) as DeployRequestResult;
  // The MCP opens the SAME review gate — it does NOT self-deploy live.
  assert.equal(res.kind, 'review');
});

test('INVARIANT: Platform MCP is a front door, NOT a back door — no privileged path', async () => {
  const app = (await callPlatformMcp(creator, 'create_software', {
    name: 'MCP Renewals 2',
    template: 'nextjs-supabase',
  })) as App;
  const res = (await callPlatformMcp(creator, 'request_deploy', { appId: app.id })) as DeployRequestResult;
  assert.equal(res.kind, 'review');
  const cardId = res.kind === 'review' ? res.card.id : '';

  // Creator CANNOT promote via the MCP (same 403 as the UI role gate).
  await expectStatus(callPlatformMcp(creator, 'promote', { appId: app.id }), 403);
  // Creator CANNOT self-approve their deploy via the MCP.
  await expectStatus(callPlatformMcp(creator, 'decide_deploy', { cardId, decision: 'approve' }), 403);
  // An unknown/admin-only back-door tool does not exist.
  await expectStatus(callPlatformMcp(creator, 'force_deploy', { appId: app.id }), 400);

  // Only a Builder can decide — identical to the UI.
  const decided = (await callPlatformMcp(builder, 'decide_deploy', { cardId, decision: 'approve' })) as { app: App };
  assert.equal(decided.app.deploy.state, 'live');
});

test('INVARIANT: the MCP surface is exactly the governed ops (no hidden escalation)', () => {
  const names = platformMcpToolNames();
  for (const t of ['create_software', 'commit', 'start_preview', 'request_deploy', 'decide_deploy', 'promote', 'archive', 'delete']) {
    assert.equal(names.includes(t), true, `missing ${t}`);
  }
  // No tool that bypasses review/roles.
  assert.equal(names.some((n) => /force|override|sudo|root|bypass/i.test(n)), false);
});

test('STAGES: the surface exposes the five governed stages (Define·Design·Build·Test·Publish)', () => {
  const names = platformMcpToolNames();
  for (const t of ['create_software', 'design_software', 'build_software', 'verify_software', 'request_deploy']) {
    assert.equal(names.includes(t), true, `missing stage tool ${t}`);
  }
});

test('DEVELOPER MODE: commit is role-gated to builder/admin AND labelled — a Creator cannot bypass', async () => {
  const app = (await callPlatformMcp(creator, 'create_software', { name: 'Dev mode app', template: 'sovereign-app' })) as App;
  // A Creator calling the raw commit is denied (403) — no bypass of the staged governance.
  await expectStatus(callPlatformMcp(creator, 'commit', { appId: app.id, files: [{ path: 'x.txt', content: 'hi' }] }), 403);
  // A Builder in the domain CAN use developer mode.
  const res = (await callPlatformMcp(builder, 'commit', { appId: app.id, files: [{ path: 'x.txt', content: 'hi' }] })) as unknown;
  assert.ok(res);
  // The tool is LABELLED as the developer-mode escape hatch.
  const commit = PLATFORM_MCP_TOOLS.find((t) => t.name === 'commit');
  assert.match(commit?.description ?? '', /DEVELOPER MODE/);
  assert.match(commit?.description ?? '', /BYPASS/i);
});

test('BUILD GATE: build_software enforces the design-before-build gate (no spec → 409), passes once designed', async () => {
  const app = (await callPlatformMcp(creator, 'create_software', { name: 'Gated app', template: 'sovereign-app' })) as App;
  // Author an epic with ONE story but NO spec yet.
  await callPlatformMcp(creator, 'design_software', {
    appId: app.id,
    epics: [{ id: 'e1', title: 'E', stories: [{ id: 's1', title: 'S', asA: 'u', iWant: 'x', soThat: 'y' }] }],
  });
  // Building it is blocked by the design-before-build gate (409).
  await expectStatus(
    callPlatformMcp(creator, 'build_software', { appId: app.id, target: { kind: 'story', epicId: 'e1', storyId: 's1' } }),
    409,
  );
  // Now author the spec → the same story builds and returns the governed BUILD directive.
  await callPlatformMcp(creator, 'design_software', {
    appId: app.id,
    epics: [{ id: 'e1', title: 'E', stories: [{ id: 's1', title: 'S', asA: 'u', iWant: 'x', soThat: 'y', spec: { features: ['F1'], nfrs: [], rules: [] } }] }],
  });
  const build = (await callPlatformMcp(creator, 'build_software', {
    appId: app.id,
    target: { kind: 'story', epicId: 'e1', storyId: 's1' },
  })) as { stage: string; tier: string; gate: string; directive: string };
  assert.equal(build.stage, 'build');
  assert.equal(build.tier, 'standard');
  assert.equal(build.gate, 'passed');
  assert.match(build.directive, /Mode: BUILD/);
});

test('TEST: verify_software returns the 5-dimension directive + normalizes findings into refinements', async () => {
  const app = (await callPlatformMcp(creator, 'create_software', { name: 'Verify app', template: 'sovereign-app' })) as App;
  await callPlatformMcp(creator, 'design_software', {
    appId: app.id,
    epics: [{ id: 'e1', title: 'E', stories: [{ id: 's1', title: 'S', asA: 'u', iWant: 'x', soThat: 'y', spec: { features: ['F1'], nfrs: [], rules: [] } }] }],
  });
  const res = (await callPlatformMcp(creator, 'verify_software', {
    appId: app.id,
    target: { kind: 'story', epicId: 'e1', storyId: 's1' },
    findings: [
      { storyId: 's1', note: 'Empty state missing', dimension: 'ux' },
      { storyId: 'ghost', note: 'ignored — no such story' },
    ],
  })) as { stage: string; tier: string; directive: string; refinements: { storyId: string; dimension?: string }[] };
  assert.equal(res.stage, 'test');
  assert.equal(res.tier, 'reasoning');
  assert.match(res.directive, /Mode: TEST/);
  // The valid finding becomes a refinement; the ghost story is dropped honestly.
  assert.equal(res.refinements.length, 1);
  assert.equal(res.refinements[0].storyId, 's1');
  assert.equal(res.refinements[0].dimension, 'ux');
});
