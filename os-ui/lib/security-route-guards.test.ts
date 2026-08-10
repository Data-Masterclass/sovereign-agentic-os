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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(OSUI, p), 'utf8');

// ---------------------------------------------------------------------------
// Guard-pattern recognition (route-wrapper migration, wave 1).
//
// Middleware is fail-open by design, so EVERY api route handler must carry its
// own session gate. Historically that gate was an inline `requireUser()` /
// `requireAdmin()` / `requirePrincipal()` / `adminCtx()` call. The route-wrapper
// migration introduces `withRoute(...)`, which runs that same gate internally
// (its default gate is `requireUser`; an explicit `gate:` opt swaps it). So a
// handler wrapped in `withRoute(` IS guarded — this predicate accepts it as an
// equal-standing guard pattern. It stays STRICT: a route carrying NEITHER an
// inline gate NOR `withRoute(` is ungated and must fail (proven below).
//
// Deliberate exceptions (documented, not accidental): a small set of routes are
// intentionally UNAUTHENTICATED (cluster-internal sidecar endpoints) — they are
// listed explicitly so the sweep can assert "guarded OR a known exception",
// never silently pass an ungated route.
// A route is "guarded" if it reads the session (`requireUser`/`requireAdmin`/
// `requirePrincipal`/`adminCtx`/`currentUser`) or wraps the handler in
// `withRoute` (which runs `requireUser` internally by default). `currentUser` is
// the softer read used by routes that handle the anon case themselves (auth/me,
// oauth callbacks that redirect, cost checks) — still a real session read, not
// fail-open. `withRoute` matches with OR without generics (`withRoute(` /
// `withRoute<…>(`).
const GUARD_TOKENS = /requireUser|requireAdmin|requirePrincipal|adminCtx|currentUser|withRoute\s*[<(]/;
const isGuarded = (src: string) => GUARD_TOKENS.test(src);

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
  assert.match(read('app/(entry)/signin/page.tsx'), /window\.location\.assign\(next\)/, 'sign-in full-page navigates');
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
  // The repo listing logic was lifted into lib/software/repos.ts (the route is now a
  // thin auth+parse+shape wrapper); the admin-only private-repo scope lives there.
  const src = read('lib/software/repos.ts');
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
  const src = read('app/(govern)/components/layout.tsx');
  assert.match(src, /currentUser/, 'app/(govern)/components/layout.tsx must call currentUser');
  assert.match(src, /role !== 'admin'/, 'app/(govern)/components/layout.tsx must gate non-admins');
});

test('PLATFORM-GATE 2: /console is builder+ for the governed Query surface; the raw Shell stays admin-only', () => {
  // /terminal + /admin-query were consolidated into /console (Shell | Query switch).
  // The page is now builder+ (governed Query — OPA/RLS per caller). The page re-checks
  // that gate, and gates the raw Shell (arbitrary command execution) to admins only
  // via canShell; the admin-query API + terminal broker enforce the same server-side.
  const src = read('app/(build)/console/page.tsx');
  assert.match(src, /roleAtLeast\(user\.role, 'builder'\)/, 'app/(build)/console/page.tsx must have a builder+ page gate');
  assert.match(src, /canShell=\{user\.role === 'admin'\}/, 'app/(build)/console/page.tsx must gate the raw Shell to admins');
  // The Query API must be builder+, and Cube mode must stay admin-only.
  const api = read('app/api/admin-query/route.ts');
  assert.match(api, /roleAtLeast\(u\.role, 'builder'\)/, 'admin-query must gate to builder+');
  assert.match(api, /mode === 'cube'[\s\S]*?u\.role !== 'admin'/, 'admin-query Cube mode must stay admin-only');
});

test('PLATFORM-GATE 3: /about is open to all roles (moved from Admin group to Entry for transparency)', () => {
  // About / Licenses (open-source component list) is purely informational.
  // It was moved from the dissolved Admin group to the Entry group — all roles
  // can now read it. The server still calls currentUser() for future personalisation.
  const src = read('app/(entry)/about/page.tsx');
  assert.match(src, /currentUser/, 'app/(entry)/about/page.tsx must still call currentUser');
  assert.doesNotMatch(src, /role !== 'admin'/, "app/(entry)/about/page.tsx must NOT gate non-admins (all-roles accessible)");
});

test('PLATFORM-GATE 4: consolidated tab gates — Policies & Approvals is builder+, admin tabs unchanged', () => {
  const src = read('lib/core/tabs.ts');
  // Components stays strictly admin-only.
  assert.match(src, /label: 'Components'[^}]*minRole: 'admin'/s, "Tab 'Components' must declare minRole: 'admin'");
  // Admin (/platform) + Console are builder-visible: the pages themselves fail-closed
  // (Admin tile-filters to self-service; Console gates the raw Shell to admins).
  for (const label of ['Admin', 'Console']) {
    assert.match(src, new RegExp(`label: '${label}'[^}]*minRole: 'builder'`, 's'),
      `Tab "${label}" must declare minRole: 'builder' (page fail-closes for non-admins)`);
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
    'app/(system)/users/page.tsx': '/platform',
    'app/(system)/gateway/page.tsx': '/components',
    'app/(system)/orchestration/page.tsx': '/components',
    'app/(system)/consoles/page.tsx': '/components',
    'app/(system)/workbench/page.tsx': '/components',
    'app/(build)/terminal/page.tsx': '/console',
    'app/(build)/admin-query/page.tsx': '/console',
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

// ---------------------------------------------------------------------------
// WRAPPER SWEEP (route-wrapper migration): every api route is guarded by an
// inline gate OR by `withRoute` (which runs the gate internally) OR is one of a
// small, EXPLICIT set of intentionally-unauthenticated routes (each with its own
// non-session gate: an OS bearer token, a runtime token, or a public auth/health
// endpoint). This is the fail-open tripwire for the whole `app/api` tree — it
// stops any NEW or MIGRATED route from shipping with no guard at all, and it
// proves `withRoute` counts as a guard so batches 2-3 can migrate onto it.

// Intentionally unauthenticated (documented). Each is NOT a session route:
//   • auth/*         — the sign-in / sign-out / recover / verify endpoints themselves
//   • health         — liveness probe (no data)
//   • mcp, mcp/[tab] — gated by an OS-issued per-user Bearer token (not the cookie)
//   • cube/models    — cluster-internal model-sync sidecar (governed tiers only; see its docstring)
//   • agents/scheduled-run, agents/tool — gated by the runtime Bearer token (runtimeTokenOk)
const UNAUTHENTICATED_BY_DESIGN = new Set([
  'app/api/health/route.ts',
  'app/api/auth/verify/route.ts',
  'app/api/auth/logout/route.ts',
  'app/api/auth/recover/route.ts',
  'app/api/auth/login/route.ts',
  'app/api/mcp/route.ts',
  'app/api/mcp/[tab]/route.ts',
  'app/api/cube/models/route.ts',
  'app/api/agents/scheduled-run/route.ts',
  'app/api/agents/tool/route.ts',
]);

function allApiRoutes(): string[] {
  const api = resolve(OSUI, 'app/api');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === 'route.ts') out.push(relative(OSUI, full));
    }
  };
  walk(api);
  return out;
}

test('WRAPPER SWEEP: every api route is guarded (inline gate OR withRoute) — or a known unauthenticated exception', () => {
  const ungated: string[] = [];
  for (const p of allApiRoutes()) {
    if (UNAUTHENTICATED_BY_DESIGN.has(p)) continue;
    if (!isGuarded(read(p))) ungated.push(p);
  }
  assert.deepEqual(
    ungated,
    [],
    `these routes carry no session gate and are not a declared exception:\n${ungated.join('\n')}`,
  );
});

test('WRAPPER SWEEP is STRICT: a route with NEITHER an inline gate NOR withRoute fails the guard predicate', () => {
  // A synthetic ungated handler (parse + respond, no gate of any kind) must NOT
  // be recognised as guarded — this proves the predicate did not go fail-open.
  const ungatedSrc = `
    import { NextResponse } from 'next/server';
    export async function GET(req: Request) {
      const body = await req.json().catch(() => ({}));
      return NextResponse.json({ ok: true, body });
    }`;
  assert.equal(isGuarded(ungatedSrc), false, 'an ungated route must not pass the guard predicate');
  // And each accepted pattern IS recognised (inline gates + the wrapper, generics or not).
  for (const guarded of [
    'const x = await requireUser();',
    'await requireAdmin();',
    'const u = await requirePrincipal();',
    'const ctx = await adminCtx();',
    'export const GET = withRoute(async ({ user }) => NextResponse.json({}));',
    'export const POST = withRoute<{ id: string }>(async ({ user, params }) => NextResponse.json({}));',
  ]) {
    assert.equal(isGuarded(guarded), true, `must recognise as guarded: ${guarded}`);
  }
});
