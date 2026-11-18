/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A bulk action reports WHY each file failed, in the server's own words
 * USER STORY: As a Files owner who selected 12 invoices and pressed Promote, I read "12 files:
 *             add a description, at least one tag first" instead of "0 requested · 1 failed",
 *             and I am not told a domain admin will approve something that was never filed.
 * ARCHITECTURE:
 *   - Pure formatter, so the bulk path and the single-file path cannot drift apart.
 *   - Asserts the two halves of the reported defect: the reason survives, and the approval
 *     sentence appears ONLY when at least one request really was filed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverError, shortReason, summariseBulk, type BulkOutcome } from '@tabs/files/lib/bulk-result';

const GATE_400 = 'Cannot promote — add a description, at least one tag first.';

function failures(n: number, error = GATE_400): BulkOutcome[] {
  return Array.from({ length: n }, (_, i) => ({ id: `as_${i}`, name: `invoice-${i}.pdf`, ok: false, error }));
}

test('serverError prefers the body’s error text over the caller’s fallback', () => {
  assert.equal(serverError({ error: GATE_400 }, 'Could not request promotion'), GATE_400);
  // A body with no error, a non-string error, an empty one, or no body at all → the fallback.
  assert.equal(serverError({}, 'Could not request promotion'), 'Could not request promotion');
  assert.equal(serverError({ error: '   ' }, 'fallback'), 'fallback');
  assert.equal(serverError({ error: 42 }, 'fallback'), 'fallback');
  assert.equal(serverError(null, 'fallback'), 'fallback');
  assert.equal(serverError('boom', 'fallback'), 'fallback');
});

test('shortReason drops the fixed lead-in and the trailing stop so reasons collapse', () => {
  assert.equal(shortReason(GATE_400), 'add a description, at least one tag first');
  assert.equal(shortReason('Cannot promote - add a description first.'), 'add a description first');
  // Anything that is not the known lead-in is left alone (minus the trailing stop).
  assert.equal(shortReason('Not permitted to change this file'), 'Not permitted to change this file');
  assert.equal(shortReason('  '), 'no reason given');
});

test('identical reasons collapse into one counted line', () => {
  const s = summariseBulk(failures(12), { verb: 'requested', approvalNote: 'A domain admin approves each.' });
  assert.equal(s.ok, 0);
  assert.equal(s.failed, 12);
  assert.equal(s.reasons.length, 1);
  assert.equal(s.reasons[0].count, 12);
  assert.match(s.notice, /12 files: add a description, at least one tag first\./);
});

test('zero requested never claims a domain admin will approve anything', () => {
  const s = summariseBulk(failures(12), { verb: 'requested', approvalNote: 'A domain admin approves each.' });
  assert.ok(!s.notice.includes('A domain admin'), s.notice);
  assert.match(s.notice, /^Nothing requested · 12 failed\./);
  // …and the approval sentence returns the moment one request really is filed.
  const mixed = summariseBulk(
    [{ id: 'a', name: 'ok.pdf', ok: true }, ...failures(9)],
    { verb: 'requested', approvalNote: 'A domain admin approves each.' },
  );
  assert.match(mixed.notice, /^1 requested · 9 failed\. A domain admin approves each\./);
});

test('a lone failure is named; several are counted, commonest reason first', () => {
  const one = summariseBulk(failures(1), { verb: 'requested' });
  assert.match(one.notice, /invoice-0\.pdf: add a description, at least one tag first\./);
  const many = summariseBulk(
    [...failures(1, 'Cannot promote — add at least one tag first.'), ...failures(3)],
    { verb: 'requested' },
  );
  assert.equal(many.reasons.length, 2);
  assert.equal(many.reasons[0].count, 3); // the commoner reason leads
  assert.equal(many.reasons[0].names.length, 3);
});

test('skipped files are reported but are not failures', () => {
  const s = summariseBulk([{ id: 'a', name: 'a.pdf', ok: true }], { verb: 'updated', skipped: 4 });
  assert.equal(s.failed, 0);
  assert.equal(s.skipped, 4);
  assert.equal(s.notice, '1 updated · 4 skipped.');
  // Nothing at all to do still reads as a sentence, not as a success.
  assert.equal(summariseBulk([], { verb: 'requested', skipped: 2 }).notice, 'Nothing requested · 2 skipped.');
});

test('a failure with no body at all still produces a reason', () => {
  const s = summariseBulk([{ id: 'a', name: 'a.pdf', ok: false }], { verb: 'requested' });
  assert.match(s.notice, /a\.pdf: no reason given\./);
});
