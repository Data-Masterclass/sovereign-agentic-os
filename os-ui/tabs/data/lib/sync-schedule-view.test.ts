/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The schedule surfaces say what actually happens (B4 review H-3 / M-7)
 * USER STORY: As a reviewer I want a test that fails if the panel can ever hide "nothing schedules
 *             this" — the one sentence the opt-out exists to convey.
 * ARCHITECTURE: Pure functions, no DOM, no fetch: the panels render what these return.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULING_OFF_NOTE,
  SCHEDULING_OFF_NOTE_KEY,
  saveScheduleMessage,
  saveScheduleMessageKey,
  schedulingDisabledNoteKey,
  schedulingDisabled,
  schedulingDisabledNote,
} from '@tabs/data/lib/sync-schedule-view';
import { textFor, CATALOG_LOCALES } from '@core/testing/catalog-text';

const text = textFor('data');

test('the flag-off detail is shown even though the outcome is ok (review H-3a)', () => {
  // This is verbatim the shape `reconcileSyncSchedule` returns with the flag off: ok TRUE.
  const out = {
    ok: true,
    live: true,
    action: 'noop' as const,
    name: 'data-sync-ds_orders',
    detail: 'DATA_PROJECT_GIT is off: the sync configuration is saved, but nothing schedules it.',
  };
  const msg = saveScheduleMessage(out);
  assert.match(msg, /nothing schedules it/, 'the sentence that matters must reach the user');
  assert.match(msg, /^✓ Saved — /);
});

test('the flag-on detail is shown too — the user learns who runs their schedule', () => {
  const msg = saveScheduleMessage({ ok: true, detail: 'Dagster schedules this sync from the domain repository (os/schedules.yml, UTC) — no CronJob is provisioned.' });
  assert.match(msg, /Dagster schedules this sync/);
});

test('a failure still leads with the warning, and never swallows an empty detail', () => {
  assert.equal(saveScheduleMessage({ ok: false, detail: 'Kubernetes rejected the CronJob deletion (HTTP 403).' }), 'Saved — but: Kubernetes rejected the CronJob deletion (HTTP 403).');
  assert.equal(saveScheduleMessage({ ok: false, detail: '' }), 'Saved — but: the schedule could not be reconciled.');
});

test('no outcome at all ⇒ the bare confirmation, with the caller\'s own verb', () => {
  assert.equal(saveScheduleMessage(undefined), '✓ Saved');
  assert.equal(saveScheduleMessage(null, 'Sync attached'), '✓ Sync attached');
});

test('the pickers carry the opt-out note iff the read-back came from the ledger (review M-7)', () => {
  assert.equal(schedulingDisabled('ledger'), true);
  assert.equal(schedulingDisabled('dagster'), false);
  assert.equal(schedulingDisabled(undefined), false, 'unknown is not a claim that scheduling is off');
  assert.equal(schedulingDisabledNote('ledger'), SCHEDULING_OFF_NOTE);
  assert.equal(schedulingDisabledNote('dagster'), null);
  assert.match(SCHEDULING_OFF_NOTE, /DATA_PROJECT_GIT disabled/, 'the note names the flag an operator has to flip');
  assert.match(SCHEDULING_OFF_NOTE, /nothing runs it/);
});

test('i18n: the key forms render the identical English through the catalog', () => {
  assert.equal(text({ key: SCHEDULING_OFF_NOTE_KEY }), SCHEDULING_OFF_NOTE);
  assert.equal(schedulingDisabledNoteKey('ledger'), SCHEDULING_OFF_NOTE_KEY);
  assert.equal(schedulingDisabledNoteKey('dagster'), null);
  const outcomes = [
    undefined, null, { ok: true }, { ok: true, detail: '  ' },
    { ok: true, detail: 'Dagster schedules this sync from the domain repository.' },
    { ok: false, detail: 'Kubernetes rejected the CronJob deletion (HTTP 403).' }, { ok: false, detail: '' },
  ];
  for (const o of outcomes) assert.equal(text(saveScheduleMessageKey(o)), saveScheduleMessage(o));
});

test('i18n: every key these helpers return exists in all 7 languages, server detail passed through verbatim', () => {
  const detail = 'DATA_PROJECT_GIT is off';
  for (const loc of CATALOG_LOCALES) {
    assert.ok(text({ key: SCHEDULING_OFF_NOTE_KEY }, loc).includes('DATA_PROJECT_GIT'), loc);
    for (const o of [undefined, { ok: false }, { ok: true, detail }, { ok: false, detail }]) {
      const out = text(saveScheduleMessageKey(o), loc);
      assert.ok(out.length > 0, loc);
      if (o?.detail) assert.ok(out.includes(detail), `${loc} keeps the server detail`);
    }
  }
});
