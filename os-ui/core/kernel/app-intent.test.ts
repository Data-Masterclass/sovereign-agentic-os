/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App intent tokens and the route guard (review H-1)
 * USER STORY: An app must not be able to start agent runs or approve held writes silently just
 *             because its iframe is same-origin and my session cookie rides along.
 * ARCHITECTURE: Pure unit test — mint/verify/guard have no I/O. Drives the guard with a plain
 *             header bag, exactly as the two route shells call it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mintAppIntent,
  verifyAppIntent,
  guardAppIntent,
  APP_INTENT_HEADER,
  APP_ORIGIN_HEADER,
  APP_INTENT_TTL_SECONDS,
} from './app-intent.ts';

const amir = { id: 'amir' };
const headers = (h: Record<string, string>) => ({
  get: (n: string) => h[n.toLowerCase()] ?? null,
});
const appRun = () => mintAppIntent({ userId: 'amir', appSlug: 'invoices', scopes: ['agent-run'] });

test('mint → verify round-trips the user, the app and the scopes', () => {
  const v = verifyAppIntent(appRun());
  assert.ok(v.ok);
  assert.equal(v.ok && v.intent.userId, 'amir');
  assert.equal(v.ok && v.intent.appSlug, 'invoices');
  assert.deepEqual(v.ok && v.intent.scopes, ['agent-run']);
});

test('verify REFUSES a missing, malformed, forged or expired token, and says which', () => {
  for (const [token, re] of [
    ['', /no app intent token/],
    ['garbage', /malformed/],
    ['Zm9v.YmFy', /signature does not verify/],
  ] as const) {
    const v = verifyAppIntent(token);
    assert.equal(v.ok, false);
    assert.match(v.ok ? '' : v.reason, re);
  }
  // A FORGED payload with a valid-looking shape: flip the scope and keep the old signature.
  const good = appRun();
  const [b64, sig] = good.split('.');
  const tampered = Buffer.from(Buffer.from(b64, 'base64url').toString('utf8').replace('agent-run', 'approval-decide'), 'utf8').toString('base64url');
  const forged = verifyAppIntent(`${tampered}.${sig}`);
  assert.equal(forged.ok, false);
  assert.match(forged.ok ? '' : forged.reason, /signature does not verify/, 'a widened scope does not survive the HMAC');

  const old = mintAppIntent({ userId: 'amir', appSlug: 'invoices', scopes: ['agent-run'], now: 0 });
  const expired = verifyAppIntent(old, APP_INTENT_TTL_SECONDS + 10);
  assert.equal(expired.ok, false);
  assert.match(expired.ok ? '' : expired.reason, /has expired/);
});

test('mint refuses a token with no user or no known scope', () => {
  assert.throws(() => mintAppIntent({ userId: '', appSlug: 'x', scopes: ['agent-run'] }), /acting user/);
  assert.throws(() => mintAppIntent({ userId: 'amir', appSlug: 'x', scopes: [] }), /at least one known scope/);
  assert.throws(() => mintAppIntent({ userId: 'amir', appSlug: 'x', scopes: ['nope' as 'agent-run'] }), /at least one known scope/);
});

test('GUARD, agent-run: the app’s intent passes; missing or forged is 403', () => {
  const ok = guardAppIntent(headers({ [APP_ORIGIN_HEADER]: 'app', [APP_INTENT_HEADER]: appRun(), 'sec-fetch-site': 'same-origin' }), amir, 'agent-run');
  assert.deepEqual(ok, { ok: true, via: 'app-intent' });

  // Says it is an app and presents NOTHING → 403 (the silent-run case).
  const none = guardAppIntent(headers({ [APP_ORIGIN_HEADER]: 'app' }), amir, 'agent-run');
  assert.equal(none.ok, false);
  assert.equal(none.ok ? 0 : none.status, 403);
  assert.match(none.ok ? '' : none.reason, /no app intent token/);

  // A forged token → 403 even without announcing itself: a token is never ignored.
  const forged = guardAppIntent(headers({ [APP_INTENT_HEADER]: 'Zm9v.YmFy' }), amir, 'agent-run');
  assert.equal(forged.ok, false);
  assert.match(forged.ok ? '' : forged.reason, /signature does not verify/);
});

test('GUARD: another user’s token is 403 — an intent is never transferable', () => {
  const theirs = mintAppIntent({ userId: 'zed', appSlug: 'invoices', scopes: ['agent-run'] });
  const out = guardAppIntent(headers({ [APP_ORIGIN_HEADER]: 'app', [APP_INTENT_HEADER]: theirs }), amir, 'agent-run');
  assert.equal(out.ok, false);
  assert.match(out.ok ? '' : out.reason, /minted for a different user/);
});

test('GUARD, approval-decide: an APP IS REFUSED — the scope split is the whole point', () => {
  const out = guardAppIntent(headers({ [APP_ORIGIN_HEADER]: 'app', [APP_INTENT_HEADER]: appRun() }), amir, 'approval-decide');
  assert.equal(out.ok, false);
  assert.equal(out.ok ? 0 : out.status, 403);
  assert.match(out.ok ? '' : out.reason, /an app may not decide an approval/);
  assert.match(out.ok ? '' : out.reason, /the app can only ask the OS to show you the confirmation/);

  // The host shell, holding a shell-scoped intent, DOES pass.
  const shell = mintAppIntent({ userId: 'amir', appSlug: '', scopes: ['approval-decide'] });
  assert.deepEqual(
    guardAppIntent(headers({ [APP_INTENT_HEADER]: shell }), amir, 'approval-decide'),
    { ok: true, via: 'app-intent' },
  );
});

test('GUARD: a cross-site POST is refused outright, whatever it presents', () => {
  for (const site of ['cross-site', 'same-site']) {
    const out = guardAppIntent(headers({ 'sec-fetch-site': site, [APP_INTENT_HEADER]: appRun() }), amir, 'agent-run');
    assert.equal(out.ok, false, site);
    assert.equal(out.ok ? 0 : out.status, 403);
  }
  assert.equal(guardAppIntent(headers({ 'sec-fetch-site': 'none' }), amir, 'agent-run').ok, true, 'a direct navigation is allowed');
});

test('GUARD: the OS UI’s own call — neither header — passes, and the limit is DOCUMENTED', () => {
  assert.deepEqual(guardAppIntent(headers({ 'sec-fetch-site': 'same-origin' }), amir, 'agent-run'), { ok: true, via: 'os-ui' });
  assert.deepEqual(guardAppIntent(headers({}), amir, 'approval-decide'), { ok: true, via: 'os-ui' });
  // This is the honest limit of a header guard on our own origin, and the module says so — the
  // app frame's CSP is what keeps app JavaScript off the governance route.
  const src = readFileSync(new URL('./app-intent.ts', import.meta.url), 'utf8');
  assert.match(src, /cannot by itself stop a HOSTILE app that simply omits the\n \* +headers/);
  assert.match(src, /connect-src/);
});
