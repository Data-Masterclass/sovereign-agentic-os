/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Test — the "Personal data before Company certification" admin setting
 * USER STORY: As a platform admin I choose block (default), confirm or off; a non-admin cannot, a
 *             made-up value is refused, every change is audited old → new, and the certify gate
 *             reads exactly what I saved (block until the store has been read).
 * ARCHITECTURE: the real settings route over the real settings store and the real kernel holder
 *             (`core/policy/personal-data-rule.ts`). `adminCtx` is a stand-in that refuses a
 *             non-admin exactly as `requireAdmin` does (403); `audit` records.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let ROLE = 'admin';
const AUDIT: { action: string; detail: string; actor: string; data?: Record<string, unknown> }[] = [];
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

const { PATCH } = await import('@/app/api/platform-admin/settings/route');
const { _reset, getSettings, __setForTests, personalDataBeforeCompany } = await import('@tabs/admin/lib/settings');
const { effectivePersonalDataRule } = await import('@core/policy/personal-data-rule');

beforeEach(() => { _reset(); ROLE = 'admin'; AUDIT.length = 0; AUDIT_FAILS = false; });
const patch = (body: unknown) => PATCH(new Request('http://x/api/platform-admin/settings', { method: 'PATCH', body: JSON.stringify(body) }));

test('the default is block, and until the store answers the gate applies block', () => {
  assert.equal(getSettings().personalDataBeforeCompany, 'block');
  assert.equal(personalDataBeforeCompany(), 'block');
  assert.deepEqual(effectivePersonalDataRule(), { rule: 'block', saved: 'block', known: false });
});

test('an admin sets confirm: saved, published to the certify gate, and audited old → new', async () => {
  const res = await patch({ personalDataBeforeCompany: 'confirm' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).settings.personalDataBeforeCompany, 'confirm');
  assert.deepEqual(effectivePersonalDataRule(), { rule: 'confirm', saved: 'confirm', known: true });
  const row = AUDIT.find((a) => a.action === 'settings.personal-data-rule');
  assert.ok(row, 'a dedicated audit row');
  assert.equal(row.actor, 'ada');
  assert.match(row.detail, /block → confirm/);
  assert.deepEqual(row.data, { from: 'block', to: 'confirm' });
  await patch({ personalDataBeforeCompany: 'off' });
  assert.equal(effectivePersonalDataRule().rule, 'off');
});

test('a non-admin cannot change it: 403, nothing saved, nothing audited, the gate unchanged', async () => {
  ROLE = 'builder';
  const res = await patch({ personalDataBeforeCompany: 'off' });
  assert.equal(res.status, 403);
  assert.equal(getSettings().personalDataBeforeCompany, 'block');
  assert.equal(effectivePersonalDataRule().rule, 'block');
  assert.equal(AUDIT.length, 0);
});

test('a made-up value is refused with 400 — a privacy control is never set by accident', async () => {
  const res = await patch({ personalDataBeforeCompany: 'sometimes' });
  assert.equal(res.status, 400);
  assert.equal(getSettings().personalDataBeforeCompany, 'block');
  assert.equal(AUDIT.length, 0);
});

test('when the audit row cannot be written the change is undone (setting and gate)', async () => {
  AUDIT_FAILS = true;
  const res = await patch({ personalDataBeforeCompany: 'off' });
  assert.equal(res.status, 500);
  assert.equal(getSettings().personalDataBeforeCompany, 'block');
  assert.equal(effectivePersonalDataRule().saved, 'block');
});

test('an unrelated settings patch keeps the rule and writes no rule audit row', async () => {
  __setForTests({ personalDataBeforeCompany: 'confirm' });
  await patch({ currency: 'CHF' });
  assert.equal(getSettings().personalDataBeforeCompany, 'confirm');
  assert.equal(AUDIT.filter((a) => a.action === 'settings.personal-data-rule').length, 0);
});
