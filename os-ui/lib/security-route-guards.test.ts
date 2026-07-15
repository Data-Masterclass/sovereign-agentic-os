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
  // Promotion runs through the governed ladder entry (promoteOrRequest → seam), never a
  // direct promoteSystem back door; a non-approver owner files a request instead of 403.
  assert.match(read('app/api/agents/systems/[id]/promote/route.ts'), /promoteOrRequest|promoteThroughSeam/);
});

test('GAP 3: marketplace import paths gate on Builder+ (rank-based — domain_admin inherits)', () => {
  assert.match(read('lib/marketplace/adapters.ts'), /!roleAtLeast\(viewer\.role, 'builder'\)/, 'GovernedImportAdapter.import gates Builder+');
  assert.match(read('lib/core/artifacts.ts'), /roleRank\(user\.role\) < roleRank\('builder'\)/, 'addFromMarketplace gates Builder+');
  assert.match(read('lib/data/store.ts'), /!roleAtLeast\(importer\.role, 'builder'\)/, 'importProduct gates Builder+');
  assert.match(read('lib/core/tabs.ts'), /Marketplace'[^\n]*role: 'Builder/, 'Marketplace tab carries a role hint');
});

test('GAP 7 (consolidation): the duplicate governance users route is GONE; user admin is the single Admin surface', () => {
  // The Governance "Users & access" component + /api/governance/users route
  // duplicated Admin → Users & Access (same `users` store). They were removed in
  // the Governance/Admin consolidation; Admin (/api/platform-admin/access) is the
  // single canonical user-admin surface.
  assert.ok(!existsSync(resolve(OSUI, 'app/api/governance/users/route.ts')), 'duplicate governance users route deleted');
  assert.ok(!existsSync(resolve(OSUI, 'components/governance/UsersAccess.tsx')), 'orphaned governance UsersAccess component deleted');
  // The domain_admin scoping predicates still exist (pure + unit-tested) in
  // lib/governance/roles.ts so the capability model is preserved for reuse.
  const roles = read('lib/governance/roles.ts');
  for (const pred of ['canAdministerUsers', 'userAdminInScope', 'canTouchUser', 'canManageRole']) {
    assert.match(roles, new RegExp(pred), `${pred} predicate preserved in roles.ts`);
  }
});

test('GAP 8 (4-rank migration): the Platform-group user routes stay requireAdmin (tab gating from 0.1.31 not reopened)', () => {
  for (const p of ['app/api/users/route.ts', 'app/api/users/[id]/route.ts']) {
    assert.match(read(p), /requireAdmin/, `${p} must stay admin-only`);
  }
  assert.match(read('app/api/platform-admin/access/route.ts'), /adminCtx/, 'platform-admin access stays adminCtx-gated');
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

test('LOCKDOWN: /api/data/ask requires a session, scopes context via listAskable, executes ONLY via queryRun(sql, principal)', () => {
  const src = read('app/api/data/ask/route.ts');
  assert.match(src, /requirePrincipal/, 'ask must gate on a session (401 for anon)');
  assert.match(src, /listAskable\(user\)/, 'the LLM context must be the canView-scoped registry list');
  assert.match(src, /queryRun\(sql, principal\)/, 'execution must go through the governed read path');
  assert.match(src, /runAsk\(/, 'generation must pass the validating orchestrator (read-only single SELECT)');
  assert.doesNotMatch(src, /body\.principal/, 'principal must come from the session, never the body');
  assert.doesNotMatch(src, /body\.sql/, 'the client can never supply the SQL — only the question');
  assert.match(src, /trace\(\{/, 'every ask turn is Langfuse-traced');
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
  const src = read('lib/infra/governed.ts');
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
  'app/api/agents/tool-catalog/route.ts',
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

test('ROLE-PERMS: the role-permissions API is admin-only on both verbs', () => {
  const src = read('app/api/platform-admin/roles/route.ts');
  // adminCtx() is the authoritative admin gate (401 anon / 403 non-admin).
  assert.match(src, /adminCtx\(\)/, 'GET/PATCH must pass through adminCtx');
  // The mutating verb recompiles OPA grants for the affected role's users.
  assert.match(src, /compileRoleToGrants/, 'PATCH must recompile OPA grants on change');
  assert.match(src, /audit\(/, 'PATCH must audit the capability change');
});

// ---------------------------------------------------------------------------
// Platform-group page gates (sidebar tab → server enforces the same rule).
// ---------------------------------------------------------------------------

test('PLATFORM-GATE 1: /components has a server-side admin layout', () => {
  const src = read('app/components/layout.tsx');
  assert.match(src, /currentUser/, 'app/components/layout.tsx must call currentUser');
  assert.match(src, /role !== 'admin'/, 'app/components/layout.tsx must gate non-admins');
});

test('PLATFORM-GATE 2: /console (merged Terminal+Query) is admin-only at the page level', () => {
  // /terminal was consolidated into /console (Shell | Query switch). The Console
  // page server component re-checks the admin gate before rendering.
  const src = read('app/console/page.tsx');
  assert.match(src, /role !== 'admin'/, 'app/console/page.tsx must have admin-only gate');
});

test('PLATFORM-GATE 3: /about is open to all roles (moved from Admin group to Entry for transparency)', () => {
  // About / Licenses (open-source component list) is purely informational.
  // It was moved from the dissolved Admin group to the Entry group — all roles
  // can now read it. The server still calls currentUser() for future personalisation.
  const src = read('app/about/page.tsx');
  assert.match(src, /currentUser/, 'app/about/page.tsx must still call currentUser');
  assert.doesNotMatch(src, /role !== 'admin'/, "app/about/page.tsx must NOT gate non-admins (all-roles accessible)");
});

test('PLATFORM-GATE 4: consolidated tab gates — Policies & Approvals is builder+, admin tabs unchanged', () => {
  const src = read('lib/core/tabs.ts');
  // Admin-gated tabs: Admin (/platform), Components, Console (merged Terminal+Query).
  for (const label of ['Admin', 'Components', 'Console']) {
    assert.match(src, new RegExp(`label: '${label.replace('/', '\\/')}[^']*'[^}]*minRole: 'admin'`, 's'),
      `Tab "${label}" must declare minRole: 'admin'`);
  }
  // Policies & Approvals (renamed from Governance): builders approve promotions.
  assert.match(src, /label: 'Policies & Approvals'[^}]*minRole: 'builder'/s,
    "Policies & Approvals must declare minRole: 'builder'");
  // About / Licenses: moved to Entry — visible to all roles, no minRole.
  const aboutBlock = src.match(/label: 'About \/ Licenses'[^}]*/s)?.[0] ?? '';
  assert.doesNotMatch(aboutBlock, /minRole/, "About / Licenses must not declare minRole (all-roles visible)");
  // Tutorials must NOT carry minRole (visible to all — students need it).
  const tutBlock = src.match(/label: 'Tutorials'[^}]*/s)?.[0] ?? '';
  assert.doesNotMatch(tutBlock, /minRole/, "Tutorials must not declare minRole (all-roles visible)");
  // Terminal and Query must be gone from the nav (merged into Console).
  assert.doesNotMatch(src, /label: 'Terminal'/, "Terminal tab must be gone (merged into Console)");
  assert.doesNotMatch(src, /label: 'Query'/, "Query tab must be gone (merged into Console)");
  // Governance label renamed to Policies & Approvals.
  assert.doesNotMatch(src, /label: 'Governance'/, "Governance label must be gone (renamed to Policies & Approvals)");
});

test('PLATFORM-GATE 5: removed tab routes are redirect stubs, not content (no 404s for old links)', () => {
  const targets: Record<string, string> = {
    'app/users/page.tsx': '/platform',
    'app/gateway/page.tsx': '/components',
    'app/orchestration/page.tsx': '/components',
    'app/consoles/page.tsx': '/components',
    'app/workbench/page.tsx': '/components',
    'app/terminal/page.tsx': '/console',
    'app/admin-query/page.tsx': '/console',
  };
  for (const [p, target] of Object.entries(targets)) {
    const src = read(p);
    assert.match(src, /from 'next\/navigation'/, `${p} must use next/navigation redirect`);
    assert.match(src, new RegExp(`redirect\\('${target}'\\)`), `${p} must redirect to ${target}`);
  }
});

test('RUN PATH: the agent RUN route derives a real default task, never "Test invocation"', () => {
  const src = read('app/api/agents/systems/[id]/run/route.ts');
  // The run path must fall back to a purpose-derived default, not the literal probe string.
  assert.match(src, /defaultRunTask\(view\.system\)/, 'an empty run prompt falls back to defaultRunTask');
  assert.doesNotMatch(src, /:\s*'Test invocation'/, 'the RUN path no longer defaults to "Test invocation"');
});
