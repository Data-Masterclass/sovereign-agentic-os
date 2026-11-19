/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Characterisation of the shared swimlane step-title wrapper
 * USER STORY: As a maintainer who merged the canvas copy and the printed-SVG copy of `wrapTitle`
 *             into one, I want the exact lines the old copies produced pinned down.
 * ARCHITECTURE:
 *   - Expected values were produced by running the pre-merge `SwimlaneCanvas.wrapTitle` from git
 *     on the same inputs (both pre-merge copies had identical code).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapTitle } from '@tabs/knowledge/lib/swimlane-layout';

const CASES: [string, string[]][] = [
  ['', ['']],
  ['Approve', ['Approve']],
  ['Approve the purchase order', ['Approve the purchase', 'order']],
  [
    'Check the customer credit limit against the approved policy and escalate',
    ['Check the customer', 'credit limit against the', 'approved policy and…'],
  ],
  ['Supercalifragilisticexpialidocious-and-more word', ['Supercalifragilisticexp…', 'word']],
  [
    'a b c d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd ee ff gg hh',
    ['a b c d e f g h i j k l', 'm n o p q r s t u v w x', 'y z aa bb cc dd ee ff gg…'],
  ],
];

test('wrapTitle: whole words, 24 chars a line, 3 lines, ellipsis only on overflow', () => {
  for (const [title, lines] of CASES) assert.deepEqual(wrapTitle(title), lines, title);
});
