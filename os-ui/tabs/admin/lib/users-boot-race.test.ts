/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Regression for the 0.9.21 boot race in the user directory.
 * USER STORY: As a user I want to keep my sign-in when os-ui boots under load: a slow or aborted
 *             directory load must never replace the full directory with an empty one, and must
 *             never re-seed the bootstrap accounts over a populated directory.
 * ARCHITECTURE:
 *   - A scriptable OpenSearch fake (fetch): the FIRST `_search` answers completely after 300 ms
 *     with 92 users (the live size); every later `_search` is aborted (no answer). Several callers
 *     load the directory concurrently, as the boot reconcilers do.
 */
process.env.OS_ALLOW_OFFLINE_USER_SEED = 'false';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const USERS = Array.from({ length: 92 }, (_, i) => ({
  id: `u${i}@example.com`, name: `U${i}`, email: `u${i}@example.com`, password: 'scrypt$x$y', role: 'creator', domains: ['europace'], emailVerified: true, createdAt: 1,
}));
const META = { id: '__meta__', initialized: true };

test('concurrent boot loads where a second one aborts: the directory ends COMPLETE, never empty, and nothing is seeded', async () => {
  const orig = globalThis.fetch;
  let searches = 0;
  const writes: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/_count')) return json({ count: USERS.length + 1 });
    if (path.includes('/_search')) {
      const n = ++searches;
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 300));
        const hits = [META, ...USERS].map((_source) => ({ _source }));
        return json({ timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: hits.length, relation: 'eq' }, hits } });
      }
      throw Object.assign(new Error('aborted'), { name: 'AbortError' }); // the aborted load
    }
    if (method === 'PUT' || method === 'POST') writes.push(path);
    return json({ result: 'ok' });
  }) as typeof fetch;
  const users = await import('@tabs/admin/lib/users');
  users.__resetUsers();
  try {
    const lists = await Promise.all([users.listUsers(), users.listUsers(), users.knownDomains(), users.listUsers()]);
    assert.equal((lists[0] as unknown[]).length, 92);
    assert.equal((lists[3] as unknown[]).length, 92);
    assert.equal(searches, 1, 'concurrent callers share ONE in-flight load');
    // A later caller after the load still sees the complete directory (no re-load replaced it).
    assert.equal((await users.listUsers()).length, 92);
    assert.ok(!writes.some((w) => /\/_doc\/admin\b/.test(w)), 'no bootstrap account was seeded over the directory');
  } finally {
    globalThis.fetch = orig;
    users.__resetUsers();
  }
});
