/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Route test — the Langfuse masking switch is admin-only, validated and audited
 * USER STORY: As a platform admin I switch trace masking on; a non-admin cannot, a made-up level is
 *             ignored, and the audit trail records who set what.
 * ARCHITECTURE: the real settings route over the real settings store. `adminCtx` is replaced by a
 *             stand-in that refuses a non-admin exactly as `requireAdmin` does (403), `audit` records.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let ROLE = 'admin';
const AUDIT: { action: string; detail: string; actor: string }[] = [];
mock.module('@/app/api/platform-admin/_ctx', {
  namedExports: {
    adminCtx: async () => {
      if (ROLE !== 'admin') { const e = new Error('Admin only'); (e as Error & { status?: number }).status = 403; throw e; }
      return { user: { id: 'ada', role: 'admin', domains: [] }, tenant: { id: 't' }, opa: 'opa-allow' };
    },
    fail: (e: unknown) => new Response(JSON.stringify({ error: (e as Error).message }), { status: (e as { status?: number })?.status ?? 500, headers: { 'content-type': 'application/json' } }),
  },
});
let AUDIT_FAILS = false;
mock.module('@tabs/admin/lib/audit', { namedExports: { audit: (e: { action: string; detail: string; actor: string }) => { if (AUDIT_FAILS) throw new Error('audit store down'); AUDIT.push(e); } } });

const { PATCH, GET } = await import('@/app/api/platform-admin/settings/route');
const { _reset, getSettings } = await import('@tabs/admin/lib/settings');

beforeEach(() => { _reset(); ROLE = 'admin'; AUDIT.length = 0; AUDIT_FAILS = false; });
const patch = (body: unknown) => PATCH(new Request('http://x/api/platform-admin/settings', { method: 'PATCH', body: JSON.stringify(body) }));

test('a non-admin cannot switch masking: 403 and the setting is unchanged', async () => {
  ROLE = 'creator';
  const res = await patch({ langfuseMasking: { enabled: true, level: 'content' } });
  assert.equal(res.status, 403);
  assert.deepEqual(getSettings().langfuseMasking, { enabled: false, level: 'pii' });
  assert.equal(AUDIT.length, 0);
});

test('an admin switches it on: the response carries it, and the audit row names the actor and the new value', async () => {
  const res = await patch({ langfuseMasking: { enabled: true, level: 'content' } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).settings.langfuseMasking, { enabled: true, level: 'content' });
  const row = AUDIT.find((a) => a.action === 'settings.langfuse-masking');
  assert.ok(row, 'a dedicated audit row');
  assert.equal(row.actor, 'ada');
  assert.match(row.detail, /ON \(content\)/);
  const got = await (await GET()).json();
  assert.deepEqual(got.settings.langfuseMasking, { enabled: true, level: 'content' });
});

test('switching it off is audited too; an invalid level is ignored', async () => {
  await patch({ langfuseMasking: { enabled: true, level: 'pii' } });
  AUDIT.length = 0;
  const res = await patch({ langfuseMasking: { enabled: false, level: 'everything' } });
  assert.deepEqual((await res.json()).settings.langfuseMasking, { enabled: false, level: 'pii' });
  assert.match(AUDIT.find((a) => a.action === 'settings.langfuse-masking')!.detail, /OFF/);
});

test('an unrelated settings patch writes no masking audit row', async () => {
  await patch({ currency: 'CHF' });
  assert.equal(AUDIT.filter((a) => a.action === 'settings.langfuse-masking').length, 0);
});

// ------------------------------------------------------ 403 and consistency --

test('non-admin 403 on every verb of the route, for the masking field and for any other field; nothing is written or audited', async () => {
  ROLE = 'creator';
  const get = await GET();
  assert.equal(get.status, 403, 'a non-admin cannot even read the settings');
  const other = await patch({ currency: 'CHF' });
  assert.equal(other.status, 403);
  assert.equal(getSettings().currency, 'EUR');
  const masking = await patch({ langfuseMasking: { enabled: false, level: 'pii' } });
  assert.equal(masking.status, 403);
  assert.equal(AUDIT.length, 0);
  // NEGATIVE TWIN: the same requests as an admin succeed.
  ROLE = 'admin';
  assert.equal((await GET()).status, 200);
  assert.equal((await patch({ currency: 'CHF' })).status, 200);
});

test('CONSISTENCY: when the audit row cannot be written the settings write is undone - both fail', async () => {
  AUDIT_FAILS = true;
  const res = await patch({ langfuseMasking: { enabled: true, level: 'content' } });
  assert.equal(res.status, 500);
  assert.deepEqual(getSettings().langfuseMasking, { enabled: false, level: 'pii' }, 'the switch did not change');
  assert.equal(AUDIT.length, 0);
  // A non-masking field is held to the same rule.
  const other = await patch({ currency: 'CHF' });
  assert.equal(other.status, 500);
  assert.equal(getSettings().currency, 'EUR');
  // NEGATIVE TWIN: with the audit store up, both succeed together.
  AUDIT_FAILS = false;
  const ok = await patch({ langfuseMasking: { enabled: true, level: 'content' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(getSettings().langfuseMasking, { enabled: true, level: 'content' });
  assert.ok(AUDIT.some((a) => a.action === 'settings.langfuse-masking'));
});

test('CONSISTENCY: when the settings write is refused, no audit row says it happened', async () => {
  const res = await patch({ langfuseMasking: { enabled: true, level: 'content' }, ssoClientSecret: 'x' });
  assert.equal(res.status, 400);
  assert.deepEqual(getSettings().langfuseMasking, { enabled: false, level: 'pii' });
  assert.equal(AUDIT.length, 0);
});
