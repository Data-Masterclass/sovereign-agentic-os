/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * repos — the Forgejo repo listing + scaffold logic lifted verbatim out of
 * app/api/software/route.ts. These pin the load-bearing, behaviour-preserving bits:
 *   • the admin-only private-repo visibility scope (security tripwire),
 *   • the empty-name guard returns 400 BEFORE any Forgejo call,
 *   • a Forgejo outage on listing surfaces as 502.
 */
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { listRepos, createRepo } from './repos.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  } as unknown as Response;
}

const ADMIN: CurrentUser = { id: 'a', name: 'A', domains: ['eng'], role: 'admin' };
const CREATOR: CurrentUser = { id: 'c', name: 'C', domains: ['eng'], role: 'creator' };

const REPOS = {
  data: [
    { name: 'pub', full_name: 'o/pub', private: false },
    { name: 'sec', full_name: 'o/sec', private: true },
  ],
};

test('listRepos: admin sees private repos; non-admin does not', async () => {
  // First call = repo search; second call = the demo CI tasks (return empty runs).
  mock.method(globalThis, 'fetch', async (url: string) =>
    String(url).includes('/repos/search') ? jsonResponse(REPOS) : jsonResponse({ workflow_runs: [] }),
  );
  const asAdmin = await listRepos(ADMIN);
  assert.equal(asAdmin.status, 200);
  assert.deepEqual((asAdmin.body.repos as { name: string }[]).map((r) => r.name).sort(), ['pub', 'sec']);

  const asCreator = await listRepos(CREATOR);
  assert.deepEqual((asCreator.body.repos as { name: string }[]).map((r) => r.name), ['pub']);
});

test('listRepos: a Forgejo outage on the search surfaces as 502', async () => {
  mock.method(globalThis, 'fetch', async () => jsonResponse('down', false, 500));
  const r = await listRepos(ADMIN);
  assert.equal(r.status, 502);
  assert.match(String(r.body.error), /Could not reach Forgejo/);
});

test('createRepo: an empty/blank name returns 400 before any Forgejo call', async () => {
  let called = false;
  mock.method(globalThis, 'fetch', async () => {
    called = true;
    return jsonResponse({});
  });
  const r = await createRepo('   ', 'desc', false);
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /repository name is required/);
  assert.ok(!called, 'no Forgejo call is made for an empty name');
});
