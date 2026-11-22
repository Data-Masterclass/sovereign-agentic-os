/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory - a gates run costs compute, so it is limited per app and per user
 * USER STORY: As the platform owner I want one gates run in progress per app (a new request replaces the old
 *             one) and a ceiling per user, so a loop of verify calls cannot fill the cluster.
 * ARCHITECTURE: gates-limits.ts slots, and the governed-action class of the MCP tool. Negative twins:
 *             a different app is not superseded; releasing a slot frees it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireGateSlot, MAX_GATE_RUNS_PER_USER, __resetGateSlots } from './gates-limits.ts';
import { READ_TOOLS, needsUserConfirm } from '@core/mcp/tool-classes';
import { WRITE_TOOL_NAMES } from '@core/mcp/write-tool-meta';
import { PLATFORM_MCP_TOOLS } from './platform-mcp.ts';

test('a second run for the SAME app supersedes the first: its signal fires', () => {
  __resetGateSlots();
  const a = acquireGateSlot({ userId: 'u1', appId: 'app_1' });
  assert.equal(a.signal.aborted, false);
  const b = acquireGateSlot({ userId: 'u1', appId: 'app_1' });
  assert.equal(a.signal.aborted, true, 'the older run must be cancelled');
  assert.equal(b.signal.aborted, false);
  a.release();
  assert.equal(b.signal.aborted, false, 'releasing the superseded slot must not touch the new one');
  b.release();
});

test('NEGATIVE TWIN: a run for a DIFFERENT app is not superseded', () => {
  __resetGateSlots();
  const a = acquireGateSlot({ userId: 'u1', appId: 'app_1' });
  const b = acquireGateSlot({ userId: 'u1', appId: 'app_2' });
  assert.equal(a.signal.aborted, false);
  a.release();
  b.release();
});

test('a user over the ceiling is refused with 429 until a slot is released', () => {
  __resetGateSlots();
  const held = Array.from({ length: MAX_GATE_RUNS_PER_USER }, (_, i) => acquireGateSlot({ userId: 'u2', appId: `app_${i}` }));
  assert.throws(() => acquireGateSlot({ userId: 'u2', appId: 'app_extra' }), (e: Error & { status?: number }) => { assert.equal(e.status, 429); return true; });
  // another user is unaffected
  acquireGateSlot({ userId: 'u3', appId: 'app_x' }).release();
  held[0].release();
  acquireGateSlot({ userId: 'u2', appId: 'app_extra' }).release();
  held.slice(1).forEach((h) => h.release());
});

test('verify_app_gates is a GOVERNED ACTION: a write-class tool that needs confirmation, not a free read', () => {
  assert.equal(READ_TOOLS.includes('verify_app_gates'), false);
  assert.equal(WRITE_TOOL_NAMES.has('verify_app_gates'), true);
  assert.equal(needsUserConfirm('verify_app_gates'), true);
  assert.equal(PLATFORM_MCP_TOOLS.find((t) => t.name === 'verify_app_gates')?.write, true);
});

test('NEGATIVE TWIN: get_app_template stays a plain read', () => {
  assert.equal(READ_TOOLS.includes('get_app_template'), true);
  assert.equal(needsUserConfirm('get_app_template'), false);
});
