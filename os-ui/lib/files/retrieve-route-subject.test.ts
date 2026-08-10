/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * SERVER-DERIVED tool-gate subject for /api/files/retrieve (item 5/6). The route
 * used to pass `body.agent` straight into filesRetrieve as the OPA grantSubject,
 * so a client could name a broadly-granted agent (e.g. `sales-assistant`) and
 * elevate the tool-gate beyond what its own session authorizes. The subject must
 * come from the authenticated session, never the client body.
 */
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const SESSION = { id: 'mallory', name: 'Mallory', domains: ['marketing'], allDomains: ['marketing'], activeDomain: null, role: 'creator' };
mock.module('@/lib/core/auth', {
  namedExports: { requireUser: async () => SESSION },
});

let captured: { grantSubject?: string; principal?: { id: string; domains: string[] } } | null = null;
mock.module('@/lib/files/retrieve', {
  namedExports: {
    filesRetrieve: async (input: { grantSubject?: string; principal: { id: string; domains: string[] } }) => {
      captured = { grantSubject: input.grantSubject, principal: input.principal };
      return { decision: 'allow', policy: 'opa-allow', reason: 'ok', query: 'x', passages: [], retrievalMode: 'in-process', embedMode: 'mock', traceId: 't' };
    },
  },
});

beforeEach(() => { captured = null; });

async function loadRoute() {
  return import(`../../app/api/files/retrieve/route.ts?${Math.random()}`);
}

test('SECURITY: a client-supplied body.agent is NOT used as the tool-gate subject', async () => {
  const route = await loadRoute();
  const req = new Request('http://x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Attacker tries to elevate to the broadly-granted `sales-assistant` principal.
    body: JSON.stringify({ query: 'confidential refunds', agent: 'sales-assistant' }),
  });
  const res = await route.POST(req);
  assert.equal(res.status, 200);
  assert.ok(captured, 'filesRetrieve was called');
  // The route must NOT forward the client-controlled subject. It leaves grantSubject
  // undefined so filesRetrieve falls back to the session-derived domain/id — never
  // the attacker-named agent.
  assert.notEqual(captured!.grantSubject, 'sales-assistant', 'client cannot elevate the tool-gate subject');
  assert.equal(captured!.grantSubject, undefined, 'no client-supplied subject is forwarded');
  // The DLS principal stays clamped to the authenticated session.
  assert.deepEqual(captured!.principal, { id: 'mallory', domains: ['marketing'] });
});
