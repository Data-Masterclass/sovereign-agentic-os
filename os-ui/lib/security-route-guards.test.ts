/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Route-guard REGRESSION test. Middleware lets every `/api/*` through to self-
 * guard, so each route handler MUST carry its own gate. Next route handlers
 * cannot be imported under `node --test` (they pull `next`), so this suite reads
 * the source and asserts the gate is wired — a cheap tripwire against a fail-open
 * regression. The behavioural proofs live in the matching lib unit tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

test('GAP 1: every platform/* route requires admin', () => {
  for (const p of ['app/api/platform/toggle/route.ts', 'app/api/platform/components/route.ts', 'app/api/platform/doc/route.ts']) {
    const src = read(p);
    assert.match(src, /requireAdmin/, `${p} must call requireAdmin`);
  }
});

test('GAP 2: the agents-systems create route no longer accepts a client visibility; a promote route exists', () => {
  const create = read('app/api/agents/systems/route.ts');
  assert.doesNotMatch(create, /body\.visibility/, 'create must not read a client visibility');
  assert.ok(existsSync(resolve(OSUI, 'app/api/agents/systems/[id]/promote/route.ts')), 'promote route exists');
  assert.match(read('app/api/agents/systems/[id]/promote/route.ts'), /promoteSystem/);
});

test('GAP 3: marketplace import paths gate on Builder+', () => {
  assert.match(read('lib/marketplace/adapters.ts'), /role !== 'builder' && [^\n]*role !== 'admin'/, 'GovernedImportAdapter.import gates Builder+');
  assert.match(read('lib/artifacts.ts'), /roleRank\(user\.role\) < roleRank\('builder'\)/, 'addFromMarketplace gates Builder+');
  assert.match(read('lib/data/store.ts'), /importer\.role !== 'builder'/, 'importProduct gates Builder+');
  assert.match(read('lib/tabs.ts'), /Marketplace'[^\n]*role: 'Builder/, 'Marketplace tab carries a role hint');
});

test('GAP 4: science predict routes bind identity to the session, never the body', () => {
  for (const p of ['app/api/science/predict/route.ts', 'app/api/science/predict/rest/route.ts']) {
    const src = read(p);
    assert.match(src, /domains: user\.domains/, `${p} derives domains from the session`);
    assert.doesNotMatch(src, /body\.principal/, `${p} must not read a client principal`);
    assert.doesNotMatch(src, /body\.domain\b/, `${p} must not read a client domain`);
  }
});

test('GAP 5: the unauthenticated knowledge GET route is gone; retrieve callers pass a DLS principal', () => {
  assert.ok(!existsSync(resolve(OSUI, 'app/api/knowledge/route.ts')), 'bare /api/knowledge route deleted');
  assert.match(read('app/api/agent/tool/route.ts'), /retrieveTool\(query, \{/, 'session principal threaded');
  assert.match(read('app/api/agents/tool/route.ts'), /retrieveTool\([^)]*dls\)/, 'system DLS principal threaded');
});

test('GAP 6: the governance policies read gates on the policy.view right', () => {
  assert.match(read('app/api/governance/policies/route.ts'), /canViewPolicyPlane/);
});

test('LOCKDOWN 1: /api/query requires a session AND forwards the caller principal (no raw SQL passthrough)', () => {
  const src = read('app/api/query/route.ts');
  assert.match(src, /requireUser/, 'query must gate on a session');
  assert.match(src, /queryRun\(sql, principal\)/, 'query must forward the principal to the governed path');
  assert.doesNotMatch(src, /body\.principal/, 'principal must come from the session, never the body');
});

test('LOCKDOWN 2: /api/tables requires a session and scopes show tables to the principal', () => {
  const src = read('app/api/tables/route.ts');
  assert.match(src, /requireUser/);
  assert.match(src, /queryRun\('show tables', principal\)/, 'tables must be scoped via the principal');
});

test('LOCKDOWN 3: /api/knowledge/docs gates GET (DLS filter) + POST (session-stamped labels)', () => {
  const src = read('app/api/knowledge/docs/route.ts');
  assert.match(src, /requireUser/, 'both handlers gate on a session');
  assert.match(src, /dlsFilter\(principal\)/, 'GET pushes down the DLS grant filter');
  assert.match(src, /owner: u\.id/, 'POST stamps the owner from the session');
  assert.match(src, /domain: u\.domains\[0\]/, 'POST stamps the domain from the session');
  assert.match(src, /visibility: 'Personal'/, 'POST defaults to Personal visibility');
});

test('LOCKDOWN 4: /api/traces requires a session and scopes to the caller (admin = all)', () => {
  const src = read('app/api/traces/route.ts');
  assert.match(src, /requireUser/);
  assert.match(src, /isAdmin \? raw : raw\.filter/, 'non-admins are filtered to their own traces');
});

test('LOCKDOWN 5: the remaining proxy read routes require a session', () => {
  for (const p of [
    'app/api/gateway/route.ts',
    'app/api/chat/route.ts',
    'app/api/science/route.ts',
    'app/api/science/churn/route.ts',
    'app/api/orchestration/route.ts',
    'app/api/catalog/route.ts',
  ]) {
    assert.match(read(p), /requireUser/, `${p} must require a session`);
  }
  // catalog scopes its show-tables to the principal too.
  assert.match(read('app/api/catalog/route.ts'), /fromQueryTool\(principal\)/);
});

test('LOCKDOWN 6: the governed DATA authz spine fails CLOSED on OPA-unreachable', () => {
  const src = read('lib/governed.ts');
  assert.doesNotMatch(src, /return \{ allowed: true, policy: 'opa-unreachable' \}/, 'no hard-coded fail-open');
  assert.match(src, /allowed: config\.opaFailOpen/, 'fail-open is gated behind an explicit flag (default deny)');
});

test('LOCKDOWN 7: sign-in and sign-out do a full-page navigation to bust the router cache', () => {
  assert.match(read('app/signin/page.tsx'), /window\.location\.assign\(next\)/, 'sign-in full-page navigates');
  assert.match(read('components/Sidebar.tsx'), /window\.location\.assign\('\/signin'\)/, 'sign-out full-page navigates');
});

// LEAK-FIX: the residual unauthenticated proxy/read GET routes the final review
// found. Each GET must carry its OWN session gate (middleware is fail-open by
// design), and — because the gate throws a 401-tagged error — must fold that
// into a 401 response for anon callers. This is the comprehensive tripwire that
// stops any of them regressing back to anon access before go-live.

// Routes whose GET returns 401 for an anonymous caller (requireUser is enough).
const USER_GATED_GETS = [
  'app/api/software/route.ts',
  'app/api/agents/route.ts',
  'app/api/status/route.ts',
  'app/api/agents/models/route.ts',
];

test('LEAK-FIX 1: /api/policy GET is ADMIN-only (full grants matrix + all principal emails)', () => {
  const src = read('app/api/policy/route.ts');
  assert.match(src, /await requireAdmin\(\)/, 'policy GET must call requireAdmin');
  // The gate must run before any OPA fetch / data assembly.
  const gateAt = src.indexOf('requireAdmin');
  const fetchAt = src.indexOf('config.opaUrl');
  assert.ok(gateAt > -1 && gateAt < fetchAt, 'requireAdmin must gate BEFORE reading grants');
  // The thrown 401/403 is surfaced (errorResponse preserves the tagged status).
  assert.match(src, /errorResponse|status.*40[13]/, 'policy GET returns the tagged auth status for anon/non-admin');
});

for (const p of USER_GATED_GETS) {
  test(`LEAK-FIX: ${p} GET requires a session and returns 401 for anon`, () => {
    const src = read(p);
    assert.match(src, /await requireUser\(\)/, `${p} GET must call requireUser`);
    // The auth error is folded into a response with the tagged status (?? 401),
    // so an anonymous caller gets 401 rather than an unguarded 200 payload.
    assert.match(src, /status\?: number \}\)\.status \?\? 401/, `${p} GET must return 401 for anon`);
  });
}

test('LEAK-FIX: /api/software GET scopes private repos to admins (no cross-user private recon)', () => {
  const src = read('app/api/software/route.ts');
  assert.match(src, /user\.role === 'admin' \? all : all\.filter\(\(r\) => !r\.private\)/, 'non-admins never see private repos');
});
