/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin (users) · auth · onboarding · password
 * FEATURE:    Sign-in, recovery, first-run setup, user admin and password-strength replies carry UI codes (i18n wave 4)
 * USER STORY: As a user who picked German I want "Invalid email or password", "That email is already in use" or
 *             "Use at least 12 characters" in German, while API clients keep reading exactly the same English.
 * ARCHITECTURE: Table-tests every (English, code, params) the auth/users routes and libs emit against the catalogs
 *   (`assertServerEnglish`), drives the real recover route and the real user directory for a few of them, and
 *   proves each password rule's `common.password.*` English equals the reason the shared rule returns.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { codedError, errorBody, errorBodyOf, type ServerParams } from '@core/kernel/server-message';
import { assertServerEnglish } from '@core/testing/server-message';
import { CATALOG_LOCALES, catalogText, hasCatalogKey } from '@core/testing/catalog-text';
import { assessPasswordStrength, issuesBody, weakPasswordMessage } from '@core/kernel/password-strength';
import { hashPassword } from '@core/kernel/password';
import { __resetUsers } from '@tabs/admin/lib/users';

// ---- every coded message the area emits ---------------------------------------

const TRIPLES: [string, string, ServerParams?][] = [
  ['Too many attempts. Please wait and try again.', 'auth.tooManyAttempts'],
  ['User directory temporarily unavailable — please retry in a moment.', 'auth.directoryUnavailable'],
  ['Invalid email or password', 'auth.invalidCredentials'],
  ['Username and recovery key are required', 'auth.recoveryFieldsRequired'],
  ['Recovery failed. Check the username and key.', 'auth.recoveryFailed'],
  ['not a member of that domain', 'auth.notDomainMember'],
  ['Not authenticated', 'auth.notAuthenticated'],
  ['Invalid JSON body', 'request.invalidJson'],
  ['Setup is not available for this account', 'onboarding.setupUnavailableForAccount'],
  ['Setup is not available', 'onboarding.setupUnavailable'],
  ['Setup already completed', 'onboarding.setupCompleted'],
  ['Account not found', 'onboarding.accountNotFound'],
  ['Use the bootstrap setup for this account', 'onboarding.useBootstrapSetup'],
  ['First-login setup already completed', 'onboarding.firstLoginCompleted'],
  ['A username is required', 'users.usernameRequired'],
  ['That username is reserved', 'users.usernameReserved'],
  ['That username already exists', 'users.usernameTaken'],
  ['A password is required', 'users.passwordRequired'],
  ['At least one domain is required', 'users.domainRequired'],
  ['A valid email is required', 'users.emailRequired'],
  ['Enter a valid email address', 'users.emailInvalid'],
  ['That email is already in use', 'users.emailTaken'],
  ['User not found', 'users.notFound'],
  ['Cannot archive the last active admin', 'users.lastActiveAdminArchive'],
  ['Cannot delete the last admin', 'users.lastAdminDelete'],
  ['Cannot disable the last active admin', 'users.lastActiveAdminDisable'],
  ['Deactivate ann first: "sales" is their only domain', 'users.onlyDomain', { id: 'ann', domain: 'sales' }],
  ['The user directory did not confirm ann without "sales"', 'users.directoryNotConfirmed', { id: 'ann', domain: 'sales' }],
  ['User directory temporarily unavailable', 'users.directoryUnavailable'],
  ['Tenant status not loaded (the status store is unreachable) — refusing to decide who is active', 'users.tenantStatusUnavailable'],
  ['This endpoint does not handle passwords', 'users.noPasswordsHere'],
  ['You cannot delete your own account', 'users.cannotDeleteSelf'],
  ['The user directory is available to domain admins and administrators.', 'users.directoryRestricted'],
  ['You cannot deactivate your own account', 'users.cannotDeactivateSelf'],
  ['Cannot deactivate the last active admin', 'users.lastActiveAdminDeactivate'],
  ['Unknown op', 'users.unknownOp'],
  ['You cannot offboard your own account', 'users.cannotOffboardSelf'],
  ['ann has no domain — give them a domain before reactivating', 'users.noDomainReactivate', { id: 'ann' }],
  ['At least one domain membership is required', 'users.membershipRequired'],
  ['Use at least 12 characters', 'password.minLength', { min: 12 }],
  ['Mix upper, lower, numbers and symbols (3 of 4)', 'password.mixClasses'],
  ['That password is too common', 'password.tooCommon'],
  ['Do not include your username', 'password.containsUsername'],
  ['Avoid a single repeated character', 'password.repeatedChar'],
  ['Password is too weak', 'password.tooWeak'],
];

test('every auth / onboarding / users / password code renders exactly its English and exists in every language', () => {
  for (const [english, code, params] of TRIPLES) assertServerEnglish(errorBody(english, code, params));
});

test('the thrown error classes carry their code; a tagged throw reaches the envelope', async () => {
  const { DirectoryUnavailableError } = await import('@tabs/admin/lib/users');
  assertServerEnglish(errorBodyOf(new DirectoryUnavailableError()));
  assert.equal(new DirectoryUnavailableError().status, 503);
  assertServerEnglish(errorBodyOf(codedError(404, 'User not found', 'users.notFound')));
});

// ---- password strength: codes beside the unchanged English ---------------------

test('password issues keep the English reasons and add a stable code per rule', () => {
  const s = assessPasswordStrength('aaaa', '');
  assert.deepEqual(s.reasons, s.issues.map((i) => i.reason));
  assert.deepEqual(s.issues.map((i) => i.code), ['password.minLength', 'password.mixClasses', 'password.repeatedChar']);
  for (const i of issuesBody(s)) assertServerEnglish({ error: i.reason, code: i.code, params: i.params });
  const w = weakPasswordMessage(s);
  assert.equal(w.english, s.reasons[0]);
  assertServerEnglish(errorBody(w.english, w.code, w.params));
  assert.deepEqual(weakPasswordMessage(assessPasswordStrength('Correct-Horse-9-battery')), { english: 'Password is too weak', code: 'password.tooWeak' });
  const named = assessPasswordStrength('password', 'password');
  assert.ok(named.issues.some((i) => i.code === 'password.tooCommon'));
  assert.ok(named.issues.some((i) => i.code === 'password.containsUsername'));
});

test('the meter text (common.password.<rule>) equals the English reason in every rule', () => {
  const all = [...assessPasswordStrength('aaaa').issues, ...assessPasswordStrength('password', 'password').issues];
  for (const i of all) {
    assert.equal(catalogText('common', { key: `password.${i.rule}`, args: i.params }), i.reason);
    for (const l of CATALOG_LOCALES) assert.ok(hasCatalogKey('common', `password.${i.rule}`, l), `${l} lacks common.password.${i.rule}`);
  }
  for (const l of CATALOG_LOCALES) assert.ok(catalogText('common', 'password.strong', l).trim().length > 0);
  assert.equal(catalogText('common', { key: 'password.minLength', args: { min: 12 } }, 'pl'), 'Użyj co najmniej 12 znaków');
  assert.equal(catalogText('common', { key: 'password.minLength', args: { min: 12 } }, 'cs'), 'Použij alespoň 12 znaků');
});

// ---- the real recover route -----------------------------------------------------

async function post(body: string): Promise<Response> {
  const { POST } = await import('@/app/api/auth/recover/route');
  return POST(new Request('http://os.test/api/auth/recover', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` }, body }));
}

test('recover route: invalid JSON, missing fields and a weak password reply with codes, English unchanged', async () => {
  const bad = await post('{not json');
  assert.equal(bad.status, 400);
  assertServerEnglish(await bad.json());

  const missing = await post(JSON.stringify({ username: 'ann', key: '' }));
  assert.equal(missing.status, 400);
  const m = await missing.json();
  assert.equal(m.error, 'Username and recovery key are required');
  assertServerEnglish(m);

  const weak = await post(JSON.stringify({ username: 'ann', key: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'short' }));
  assert.equal(weak.status, 400);
  const w = await weak.json();
  assert.equal(w.error, 'Use at least 12 characters');
  assert.deepEqual(w.reasons, assessPasswordStrength('short', 'ann').reasons);
  assert.equal(w.issues.length, w.reasons.length);
  assertServerEnglish(w);
  for (const i of w.issues) assertServerEnglish({ error: i.reason, code: i.code, params: i.params });
});

// ---- the real user directory --------------------------------------------------

type Stub = (url: string, init?: { method?: string; body?: string }) => Promise<Response>;
let activeFetch: Stub | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: { method?: string; body?: string }) =>
  activeFetch ? activeFetch(url, init) : realFetch(url as string, init)) as typeof fetch;
const jsonRes = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
function openSearchStub(): Stub {
  const store = new Map<string, Record<string, unknown>>();
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    if (path === '/os-users/_count') return jsonRes({ count: store.size });
    if (path === '/os-users/_search') return jsonRes({ hits: { hits: [...store.values()].map((_source) => ({ _source })) } });
    const m = path.match(/^\/os-users\/_doc\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'PUT') { store.set(id, JSON.parse(init.body ?? '{}')); return jsonRes({ result: 'created' }); }
      if (method === 'DELETE') { store.delete(id); return jsonRes({ result: 'deleted' }); }
    }
    return jsonRes({}, 404);
  };
}

beforeEach(() => __resetUsers());

test('user directory: create / update refusals carry codes with the same English and status', async () => {
  activeFetch = openSearchStub();
  try {
    const users = await import(`./users.ts?msgs=${Date.now()}`);
    const STRONG = 'Tr0ub4dour&3-test';
    await users.setupAdmin({ bootstrapId: 'admin', username: 'ada', email: 'ada@example.com', passwordHashReady: await hashPassword(STRONG) });
    await users.createUser({ id: 'bob@example.com', email: 'bob@example.com', password: STRONG, domains: ['sales'], role: 'creator' });

    const cases: [() => Promise<unknown>, string, number][] = [
      [() => users.createUser({ id: 'bob@example.com', email: 'x@example.com', password: STRONG, domains: ['sales'], role: 'creator' }), 'That username already exists', 409],
      [() => users.createUser({ id: '', password: STRONG, domains: ['sales'], role: 'creator' }), 'A username is required', 400],
      [() => users.createUser({ id: 'cy@example.com', email: 'cy@example.com', password: STRONG, domains: [], role: 'creator' }), 'At least one domain is required', 400],
      [() => users.updateUser('bob@example.com', { email: 'not-an-email' }), 'Enter a valid email address', 400],
      [() => users.updateUser('ada', { email: 'bob@example.com' }), 'That email is already in use', 409],
      [() => users.updateUser('nobody', { name: 'x' }), 'User not found', 404],
    ];
    for (const [run, english, status] of cases) {
      await assert.rejects(run, (e: Error & { status?: number }) => {
        assert.equal(e.message, english);
        assert.equal(e.status, status);
        assertServerEnglish(errorBodyOf(e));
        return true;
      });
    }
  } finally {
    activeFetch = null;
  }
});
