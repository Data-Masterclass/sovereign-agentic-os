/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Connections "Test" route is throttled per user and connection
 * USER STORY: As an operator I want a user (or a script with their session) to be unable to hammer a
 *             remote service through "Test": at most 5 tests a minute per user and connection, then 429.
 * ARCHITECTURE: the REAL route handler and the REAL `core/kernel/ratelimit.ts`; the session wrapper and the
 *   store's `testConnection` are stand-ins, so the test proves the throttle and nothing reaches the store
 *   once it trips. Twins: another user, and another connection, keep their own budget.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let caller = { id: 'ben', name: 'Ben', domains: ['sales'], role: 'creator' };
const tested: string[] = [];
mock.module('@core/kernel/route-server', {
  namedExports: {
    withRoute: (fn: (a: { user: unknown; params: unknown; req: Request; body: unknown }) => Promise<Response>) =>
      async (req: Request, ctx: { params: Promise<Record<string, string>> }) => fn({ user: caller, params: await ctx.params, req, body: undefined }),
  },
});
mock.module('@tabs/connections/lib/index', {
  namedExports: { testConnection: async (id: string, u: { id: string }) => { tested.push(`${u.id}:${id}`); return { ok: true, mode: 'live', state: 'verified', detail: 'ok' }; } },
});
const { POST } = await import('../../os-ui/app/api/connections/[id]/test/route.ts');

const hit = (id: string) => POST(new Request(`http://os/api/connections/${id}/test`, { method: 'POST' }), { params: Promise.resolve({ id }) });

test('the 6th test of one connection by one user inside a minute is 429 with a hint, and does not reach the store', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await hit('conn_a')).status, 200);
  const r = await hit('conn_a');
  assert.equal(r.status, 429);
  const body = await r.json() as { code: string; hint: string };
  assert.equal(body.code, 'rate_limited');
  assert.match(body.hint, /Wait \d+ s/);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal(tested.filter((t) => t === 'ben:conn_a').length, 5);
});

test('TWIN: another connection and another user each keep their own budget', async () => {
  assert.equal((await hit('conn_b')).status, 200);
  caller = { ...caller, id: 'ana' };
  assert.equal((await hit('conn_a')).status, 200);
});
