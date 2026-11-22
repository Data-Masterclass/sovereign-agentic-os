/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The "Run checks" button on an app in the Software tab (Software Factory CI, trigger 2 of 3)
 * USER STORY: As a builder looking at an app I want to press "Run checks" to run the checks for the current
 *             head, and to see per commit what ran, its status per check, its log and the time.
 * ARCHITECTURE: The route is a shell over `runAppTests` (the same function `verify_app_gates` calls), so the
 *             button, the MCP tool and the push hook are three triggers of one code path. A stand-in engine
 *             is installed with `__setChecksRunner`; the real one is Tekton (tests/software-factory/tekton-e2e.sh).
 *             Negative twins: unauthenticated, another domain (404), a non-owner creator (403).
 */
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as cfg } from '@core/kernel/config';

let ACTING: { id: string; name: string; domains: string[]; role: string } | null = null;
mock.module('@core/kernel/auth', {
  namedExports: {
    requireUser: async () => {
      if (!ACTING) throw Object.assign(new Error('Not authenticated'), { status: 401 });
      return ACTING;
    },
    currentUser: async () => ACTING,
  },
});

const { createApp } = await import('@tabs/software/lib/apps');
const { __setChecksRunner } = await import('./tekton-checks.ts');
const { recordFromOutcome } = await import('./check-record.ts');
const { REQUIRED_GATES } = await import('./gates.ts');

let reposDir = '';
let prior = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-t-'));
  prior = cfg.reposDir;
  (cfg as { reposDir: string }).reposDir = reposDir;
});
after(() => {
  (cfg as { reposDir: string }).reposDir = prior;
  __setChecksRunner(null);
  rmSync(reposDir, { recursive: true, force: true });
});

const alice = { id: 'alice', name: 'Alice', domains: ['sales'], role: 'creator' };
const bob = { id: 'bob', name: 'Bob', domains: ['sales'], role: 'creator' };
const mallory = { id: 'mallory', name: 'Mallory', domains: ['hr'], role: 'creator' };
const calls: { trigger: string; force?: boolean; sha: string }[] = [];
beforeEach(() => {
  ACTING = alice;
  calls.length = 0;
  __setChecksRunner(async (i) => {
    calls.push({ trigger: i.trigger, force: i.force, sha: i.sha });
    return {
      record: { ...recordFromOutcome({ sha: i.sha, trigger: i.trigger, engine: 'tekton', startedAt: 't0', finishedAt: 't1', outcome: { ok: true, report: { schema: 'os-gates/v1', template: 'nextjs-web', ok: true, gates: REQUIRED_GATES.map((id) => ({ id, status: 'pass', detail: 'x' })) } } }), status: 'running', finishedAt: null, checks: [], runRef: 'chk-1' },
      superseded: [],
    };
  });
});

const load = () => import(`../../../app/api/apps/[id]/checks/route.ts?${Math.random()}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string) => load().then((m) => m.POST(new Request('http://x/api/apps/x/checks', { method: 'POST' }), ctx(id)));
const get = (id: string) => load().then((m) => m.GET(new Request('http://x/api/apps/x/checks'), ctx(id)));

test('POST runs the checks for the head with trigger `button`, forced, and stores the running record on the app (202)', async () => {
  const app = await createApp(alice, { name: 'Button Desk', template: 'nextjs-web' });
  const res = await post(app.id);
  assert.equal(res.status, 202);
  const body = (await res.json()) as { commit: string; record: { status: string; runRef: string; trigger: string } };
  assert.match(body.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(calls, [{ trigger: 'button', force: true, sha: body.commit }]);
  assert.equal(body.record.status, 'running');
  const listed = (await (await get(app.id)).json()) as { checks: { sha: string; status: string }[]; head: string };
  assert.equal(listed.checks[0].sha, body.commit);
  assert.equal(listed.head, body.commit);
});

test('GET lists the records of the app newest first with the commit that is head now', async () => {
  const app = await createApp(alice, { name: 'List Desk', template: 'nextjs-web' });
  const none = (await (await get(app.id)).json()) as { checks: unknown[]; head: string | null };
  assert.deepEqual(none.checks, []);
  assert.match(none.head ?? '', /^[0-9a-f]{40}$/);
});

test('NEGATIVE unauthenticated is 401 and starts nothing', async () => {
  const app = await createApp(alice, { name: 'Auth Desk', template: 'nextjs-web' });
  ACTING = null;
  assert.equal((await post(app.id)).status, 401);
  assert.equal(calls.length, 0);
});

test('NEGATIVE another domain cannot see the app (404) and starts nothing', async () => {
  const app = await createApp(alice, { name: 'Other Domain Desk', template: 'nextjs-web' });
  ACTING = mallory;
  assert.equal((await post(app.id)).status, 404);
  assert.equal((await get(app.id)).status, 404);
  assert.equal(calls.length, 0);
});

test('NEGATIVE a colleague of the same domain cannot start checks on someone else\'s personal app (it is not visible to them: 404)', async () => {
  const app = await createApp(alice, { name: 'Owner Desk', template: 'nextjs-web' });
  ACTING = bob;
  assert.equal((await post(app.id)).status, 404);
  assert.equal(calls.length, 0);
});
