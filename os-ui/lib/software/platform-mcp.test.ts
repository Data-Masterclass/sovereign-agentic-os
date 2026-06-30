/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/auth';
import { callPlatformMcp, platformMcpToolNames } from './platform-mcp.ts';
import type { App } from '@/lib/apps';
import type { DeployRequestResult } from './review.ts';

const creator: CurrentUser = { id: 'dan', name: 'Dan', domains: ['sales'], role: 'participant' };
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
  const previewed = (await callPlatformMcp(creator, 'start_preview', { appId: app.id })) as App;
  assert.equal(previewed.deploy.state, 'preview');

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
