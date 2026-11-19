/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The browser and the server judge a password with one function
 * USER STORY: As someone recovering my account with a short username, I want the form to let
 *             me submit a password the server would accept.
 * ARCHITECTURE:
 *   - Pins the server rule, and the specific case the removed client copies got wrong: they
 *     rejected any password containing the username even when the username was under 3
 *     characters, which the server deliberately ignores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPasswordStrength } from '@core/kernel/password-strength';
import { assessPasswordStrength as serverAssess } from '@core/kernel/password';

test('the server re-export is the very same function the browser imports', () => {
  assert.equal(serverAssess, assessPasswordStrength);
});

test('a username under 3 characters is not a reason to refuse (the old client copies said it was)', () => {
  assert.equal(assessPasswordStrength('Totally-secure-123', 'al').ok, true);
  assert.equal(assessPasswordStrength('Totally-secure-123', 'tally').ok, false);
});

test('length, classes and the deny-list', () => {
  assert.deepEqual(assessPasswordStrength('short', '').reasons, [
    'Use at least 12 characters',
    'Mix upper, lower, numbers and symbols (3 of 4)',
  ]);
  const strong = assessPasswordStrength('Correct-Horse-9-battery', 'admin');
  assert.equal(strong.ok, true);
  assert.equal(strong.score, 4);
});
