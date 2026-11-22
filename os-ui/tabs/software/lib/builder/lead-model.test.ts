/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The software builder follows the OS-wide lead switch: strong plans and codes, or the worker leads and strong escalates
 * USER STORY: As the owner I want the app builder on the same rule as the chat and the agents: strong leads by default, and
 *             in "Save costs" mode the worker tries first and strong redoes what fails its check.
 * ARCHITECTURE: the builder's own `completeAs` (the one model door of `loop-server.ts`) with a scripted gateway caller; the
 *             switch is the real settings value. Each test has a negative twin.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { completeAs } from '@tabs/software/lib/builder/loop-server';
import { __setStandardFirstForTests } from '@core/models/roles';
import type { AssistantCaller } from '@core/runtime/complete';

const user = { id: 'u-b', name: 'B', domains: ['sales'], role: 'builder' } as never;
beforeEach(() => { __setStandardFirstForTests(false); });

function caller(replies: Record<string, string>): { c: AssistantCaller; models: string[] } {
  const models: string[] = [];
  return { models, c: async (req) => { models.push(req.model); return replies[req.model] ?? ''; } };
}
const GOOD_CODE = JSON.stringify({ files: [{ path: 'app/page.tsx', content: 'export default function P(){return null}' }] });
const validCode = (raw: string) => raw.includes('"files"');

test('STRONG LEADS (default): the planner and the coder run on the strong role directly, with no worker call', async () => {
  const { c, models } = caller({ 'sovereign-strong': GOOD_CODE, 'sovereign-worker': 'worker text' });
  const code = completeAs(user, 'coder', { caller: c, validate: validCode });
  assert.equal(await code('sys', 'user'), GOOD_CODE);
  const plan = completeAs(user, 'reasoning', { caller: c });
  await plan('sys', 'user');
  assert.deepEqual(models, ['sovereign-strong', 'sovereign-strong']);
});

test('WORKER LEADS ("Save costs"): the coder tries the worker first and a result that fails its check is redone on strong', async () => {
  __setStandardFirstForTests(true);
  const { c, models } = caller({ 'sovereign-worker': 'sorry, no files', 'sovereign-strong': GOOD_CODE });
  const out = await completeAs(user, 'coder', { caller: c, validate: validCode })('sys', 'user');
  assert.equal(out, GOOD_CODE);
  assert.deepEqual(models, ['sovereign-worker', 'sovereign-strong']);
});

test('WORKER LEADS twin: a worker result that passes its check is final (strong is never called)', async () => {
  __setStandardFirstForTests(true);
  const { c, models } = caller({ 'sovereign-worker': GOOD_CODE, 'sovereign-strong': 'unused' });
  assert.equal(await completeAs(user, 'coder', { caller: c, validate: validCode })('sys', 'user'), GOOD_CODE);
  assert.deepEqual(models, ['sovereign-worker']);
});

test('WORKER LEADS: a step with no check (the planner) is still escalated when the worker returns nothing', async () => {
  __setStandardFirstForTests(true);
  const { c, models } = caller({ 'sovereign-worker': '', 'sovereign-strong': '1. do the thing' });
  assert.equal(await completeAs(user, 'reasoning', { caller: c })('sys', 'user'), '1. do the thing');
  assert.deepEqual(models, ['sovereign-worker', 'sovereign-strong']);
});
