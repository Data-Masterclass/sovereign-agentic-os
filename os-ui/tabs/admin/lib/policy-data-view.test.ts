/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Policy data card: refused state, the reason rule, the confirmation naming what is
 *             removed, the POST of the shown hash and the 409 answer
 * USER STORY: As an admin I want the card to say "Refused since …" prominently, to refuse my click until
 *             I give a reason, and to show in the confirmation exactly what I accept.
 * ARCHITECTURE: the view model (`policy-data-view.ts`) directly; source checks for the component, which
 *   is a `.tsx` the harness cannot import (ARCHITECTURE.md "A test cannot import a .tsx").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ackFailureMessage, confirmLines, reasonError, syncState, type PolicyDataView, type RefusalView } from '@tabs/admin/lib/policy-data-view';
import { ADMIN_SECTIONS, visibleSections } from '@tabs/admin/lib/sections';

const since = '2026-11-25T08:00:00.000Z';
const refused: RefusalView = {
  hash: 'abc123', stats: { grants: 8, principals: 5, tables: 3 }, baseStats: { grants: 20, principals: 6, tables: 4 },
  reasons: ['grant principals drop 60.0 % (20 → 8), above 10 %'], at: since, since, maxDropPercent: 10,
  diff: {
    grantPrincipals: { removed: ['user:a', 'user:b'], added: ['user:z'], removedTotal: 12, addedTotal: 1 },
    governancePrincipals: { removed: ['a'], added: [], removedTotal: 1, addedTotal: 0 },
    tables: { removed: ['iceberg.s.t'], added: [], removedTotal: 1, addedTotal: 0 },
  },
};
const base: PolicyDataView = {
  revision: '41-ffff', compiledAt: since, checkedAt: since, lastError: null, lastErrorAt: null, refused: null,
  maxDropPercent: 10, refusalAlertMinutes: 15, annotations: {}, directoryAuthoritative: true, alert: null, history: [],
};

test('state: in sync, and "Refused since <time>" with its duration when refused', () => {
  assert.equal(syncState(base, Date.parse(since)).kind, 'in-sync');
  const s = syncState({ ...base, refused }, Date.parse(since) + 330 * 60_000, () => 'TIME');
  assert.equal(s.kind, 'refused');
  assert.equal(s.headline, 'Refused since TIME (5 h 30 min)');
  assert.match(s.sub, /OPA keeps revision 41-ffff/);
  assert.equal(syncState({ ...base, revision: null }, 0).kind, 'none');
  assert.equal(syncState({ ...base, lastError: 'refused (incomplete source)' }, 0).kind, 'error');
});

test('reason: required, at least 10 characters', () => {
  assert.match(reasonError('')!, /at least 10 characters \(0 so far\)/);
  assert.match(reasonError('   short   ')!, /5 so far/);
  assert.equal(reasonError('cohort archived'), null);
});

test('confirmation names exactly what is removed, with each user state and the remainder', () => {
  const lines = confirmLines(refused, { 'user:a': 'deactivated', 'user:b': 'active', a: 'deactivated' });
  assert.equal(lines[0], 'Content abc123 will be served to OPA once.');
  assert.equal(lines[1], 'Grant principals: 12 removed — user:a (deactivated on Access), user:b (still active — check why it is removed) … and 10 more');
  assert.equal(lines[2], 'Governance principals: 1 removed — a (deactivated on Access)');
  assert.equal(lines[3], 'Governance tables: 1 removed — iceberg.s.t');
  const noDiff = confirmLines({ ...refused, diff: null }, {});
  assert.match(noDiff.join('\n'), /could not be listed/);
  assert.match(noDiff.join('\n'), /20 → 8 grant principals/);
});

test('409: review again and refresh; nothing-refused is said plainly', () => {
  const m = ackFailureMessage(409, { code: 'content-changed' });
  assert.equal(m.refresh, true);
  assert.match(m.text, /changed since you reviewed it, so it was NOT acknowledged/);
  assert.match(ackFailureMessage(409, { code: 'not-refused' }).text, /Nothing is refused any more/);
  assert.equal(ackFailureMessage(403, {}).refresh, false);
  assert.match(ackFailureMessage(503, { error: 'not acknowledged: store down' }).text, /store down/);
});

test('the card: an admin-only Platform section, wired on the page', () => {
  const s = ADMIN_SECTIONS.find((x) => x.id === 'policy-data');
  assert.equal(s?.minRole, 'admin');
  assert.equal(s?.group, 'Infrastructure');
  assert.equal(visibleSections('builder').some((x) => x.id === 'policy-data'), false);
  const page = readFileSync(join(process.cwd(), 'app/(govern)/platform/page.tsx'), 'utf8');
  assert.match(page, /current === 'policy-data' && <PolicyData \/>/);
});

test('the card: posts the hash it SHOWED with the reason, an in-page labelled dialog, no window.confirm', () => {
  const src = readFileSync(join(process.cwd(), 'tabs/admin/ui/PolicyData.tsx'), 'utf8');
  assert.match(src, /JSON\.stringify\(\{ hash, reason: reason\.trim\(\) \}\)/);
  assert.match(src, /onConfirm=\{\(\) => void acknowledge\(r\.hash\)\}/);
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
  assert.match(src, /aria-labelledby="pd-confirm-title"/);
  assert.match(src, /<label htmlFor="pd-reason"/);
  assert.match(src, /disabled=\{!!reasonMsg \|\| busy\}/, 'the button is disabled until the reason is valid');
  assert.match(src, /ackFailureMessage\(res\.status, body\)/);
  assert.match(src, /await load\(\)/, 'refreshes after every attempt');
  assert.doesNotMatch(src, /window\.confirm|\bconfirm\(/);
});
