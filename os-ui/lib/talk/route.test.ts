/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * POST /api/talk/[tab] — the governed copilot endpoint. Drives the REAL route handler with
 * `requireUser` and `talkTo` mocked, proving the SESSION GATE + input validation:
 *   - an anonymous caller gets 401 (talkTo is never reached);
 *   - an unknown tab is a 404;
 *   - a missing question is a 400;
 *   - an authed caller on a known tab reaches talkTo AS the session user (not the body).
 *
 * Requires `--experimental-test-module-mocks` (set in the npm test script) + the test-only
 * `next/server` shim (mapped by the alias hook). Lives under lib/ so the `lib/**` test glob
 * runs it (same convention as the other lib route.test.ts suites).
 */
type Actor = { id: string; name: string; domains: string[]; role: string } | null;

let ACTING: Actor = null;
let ANON = false;
mock.module('@/lib/core/auth', {
  namedExports: {
    requireUser: async () => {
      if (ANON) {
        const e = new Error('Not authenticated') as Error & { status: number };
        e.status = 401;
        throw e;
      }
      return ACTING;
    },
  },
});

let TALK_CALLS: { tab: string; question: string; userId: string }[] = [];
mock.module('@/lib/talk', {
  namedExports: {
    talkTabIds: () => ['data', 'knowledge', 'files', 'metrics', 'connections'],
    talkTo: async (tab: string, question: string, user: { id: string }) => {
      TALK_CALLS.push({ tab, question, userId: user.id });
      return { ok: true, answer: 'ok', reasoning: '', citations: [], grounding: { kind: 'none', citations: [] } };
    },
  },
});

async function post(tab: string, body: unknown, tag: string) {
  TALK_CALLS = [];
  const route = await import(`../../app/api/talk/[tab]/route.ts?${tag}`);
  const req = new Request(`http://localhost/api/talk/${tab}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = (await route.POST(req, { params: Promise.resolve({ tab }) })) as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

const AMIR: Actor = { id: 'amir', name: 'Amir', domains: ['sales'], role: 'creator' };

test('anon caller → 401 (talkTo never reached)', async () => {
  ANON = true;
  const { status } = await post('data', { question: 'hi' }, 'anon');
  assert.equal(status, 401);
  assert.equal(TALK_CALLS.length, 0);
  ANON = false;
});

test('unknown tab → 404', async () => {
  ACTING = AMIR;
  const { status } = await post('nope', { question: 'hi' }, 'badtab');
  assert.equal(status, 404);
  assert.equal(TALK_CALLS.length, 0);
});

test('missing question → 400', async () => {
  ACTING = AMIR;
  const { status } = await post('data', {}, 'noq');
  assert.equal(status, 400);
  assert.equal(TALK_CALLS.length, 0);
});

test('authed caller on a known tab reaches talkTo AS the session user', async () => {
  ACTING = AMIR;
  const { status, body } = await post('data', { question: 'total revenue?' }, 'ok');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(TALK_CALLS.length, 1);
  assert.equal(TALK_CALLS[0].tab, 'data');
  assert.equal(TALK_CALLS[0].userId, 'amir'); // the principal is the SESSION user, not the body
});
