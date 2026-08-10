/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FIRST-RUN CREDENTIAL GATE on the governance routes (item 3/6). These 5 routes
 * historically used `currentUser()`, which SKIPS the `mustChangeCredentials` gate
 * that `requireUser()` enforces (lib/core/auth.ts:80-85). A bootstrap admin who
 * has not yet set real credentials could therefore read/act on governance.
 *
 * We mock `@/lib/core/auth` so `requireUser` throws exactly the 403 it throws for
 * a `mustChangeCredentials` user. If a route still called `currentUser` (the bug),
 * mocking `requireUser` would have NO effect and the route would 200. So a 403 here
 * proves the route now goes through the gated `requireUser`.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Toggle: when true, requireUser throws the first-run-setup 403 (the gate firing).
let GATED = false;
const OK_USER = { id: 'ada', name: 'Ada', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'admin' };
function credentialGate403(): never {
  const err = new Error('Complete first-run setup before using the platform') as Error & { status?: number };
  err.status = 403;
  throw err;
}
mock.module('@/lib/core/auth', {
  namedExports: {
    requireUser: async () => (GATED ? credentialGate403() : OK_USER),
    // currentUser must NOT be the seam these routes use post-fix; if a route
    // regressed to it, this permissive stub would let the request through (200),
    // failing the assertions below.
    currentUser: async () => OK_USER,
  },
});

beforeEach(() => { GATED = false; });

async function load(path: string) {
  return import(`${path}?${Math.random()}`);
}

const ROUTES: { name: string; path: string; method: 'GET' | 'POST' }[] = [
  { name: 'cost GET', path: '../../app/api/governance/cost/route.ts', method: 'GET' },
  { name: 'cost/check POST', path: '../../app/api/governance/cost/check/route.ts', method: 'POST' },
  { name: 'audit GET', path: '../../app/api/governance/audit/route.ts', method: 'GET' },
  { name: 'approvals GET', path: '../../app/api/governance/approvals/route.ts', method: 'GET' },
  { name: 'approvals POST', path: '../../app/api/governance/approvals/route.ts', method: 'POST' },
  { name: 'policies GET', path: '../../app/api/governance/policies/route.ts', method: 'GET' },
  { name: 'policies POST', path: '../../app/api/governance/policies/route.ts', method: 'POST' },
];

for (const r of ROUTES) {
  test(`SECURITY: ${r.name} is 403'd for a user who must change credentials (gate enforced)`, async () => {
    GATED = true;
    const mod = await load(r.path);
    const handler = mod[r.method] as (req: Request, ctx?: unknown) => Promise<Response>;
    const req = new Request('http://x', {
      method: r.method,
      headers: { 'content-type': 'application/json' },
      body: r.method === 'POST' ? JSON.stringify({}) : undefined,
    });
    const res = await handler(req, { params: Promise.resolve({}) });
    assert.equal(res.status, 403, `${r.name} must fail closed at the credential gate`);
    const body = await res.json();
    assert.match(String(body.error), /first-run setup/i);
  });
}
