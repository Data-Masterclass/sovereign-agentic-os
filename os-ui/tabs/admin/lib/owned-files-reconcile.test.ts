/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An admin can see and fix a domain whose receive gate is failing closed
 * USER STORY: As an admin I want one call that regenerates a domain's os/owned-files.yml (and the rest
 *             of its generated project) so builders are not left locked out of models/ and tests/.
 * ARCHITECTURE: `GET`/`POST /api/platform-admin/data-projects/<domain>/reconcile`, admin only. The
 *             POST is the boot reconcile for ONE domain; a reconcile that could not run (flag off,
 *             registry not hydrated) answers 409 with the reason, never a silent success.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let ACTING: { id: string; role: string } = { id: 'ada', role: 'admin' };
let missing: string[] = ['sales'];
let ran = true;
let opaDeny = false;
const reconciled: string[] = [];
mock.module('@/app/api/platform-admin/_ctx', {
  namedExports: {
    adminCtx: async () => {
      if (ACTING.role !== 'admin') throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { user: ACTING, tenant: { id: 't' }, opa: 'allow' };
    },
    fail: (e: unknown) => ({ status: (e as { status?: number }).status ?? 500, async json() { return { error: (e as Error).message }; } }),
  },
});
mock.module('@core/infra/governed', { namedExports: { authorize: async () => ({ policy: opaDeny ? 'opa-deny' : 'opa-allow' }) } });
mock.module('@tabs/admin/lib/audit', { namedExports: { audit: () => undefined } });
mock.module('@core/infra/owned-files', { namedExports: { domainsMissingOwnedFiles: async () => missing } });
mock.module('@tabs/data/lib/dbt/boot-reconcile', {
  namedExports: {
    reconcileOneDomain: async (d: string) => { reconciled.push(d); return { domains: [d], committed: ran ? [{ domain: d, sha: 'a'.repeat(40) }] : [], failed: [], ran, cronsStoodDown: [] }; },
  },
});

const ctx = (domain: string) => ({ params: Promise.resolve({ domain }) });

test('GET says whether the domain lacks the list; POST reconciles that one domain and reports the commit', async () => {
  const route = await import('../../../app/api/platform-admin/data-projects/[domain]/reconcile/route.ts');
  const g = await route.GET(new Request('http://x'), ctx('sales'));
  assert.deepEqual(await g.json(), { domain: 'sales', ownedFilesMissing: true });
  const p = await route.POST(new Request('http://x', { method: 'POST' }), ctx('sales'));
  assert.equal(p.status, 200);
  assert.deepEqual(reconciled, ['sales']);
  assert.equal(((await p.json()) as { committed: unknown[] }).committed.length, 1);
});

test('NEGATIVE TWINS: a non-admin is refused; a reconcile that could not run is a 409, not a success', async () => {
  const route = await import('../../../app/api/platform-admin/data-projects/[domain]/reconcile/route.ts');
  ACTING = { id: 'bob', role: 'builder' };
  const r = await route.POST(new Request('http://x', { method: 'POST' }), ctx('sales'));
  assert.equal(r.status, 403);
  ACTING = { id: 'ada', role: 'admin' };
  opaDeny = true;
  assert.equal((await route.POST(new Request('http://x', { method: 'POST' }), ctx('sales'))).status, 403, 'OPA deny is refused');
  opaDeny = false;
  ran = false;
  const c = await route.POST(new Request('http://x', { method: 'POST' }), ctx('sales'));
  assert.equal(c.status, 409);
  assert.match(((await c.json()) as { error: string }).error, /did not run/);
});
