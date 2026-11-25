/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The composer's attachment chips — drop/paste/attach admission and destination change
 * USER STORY: As a user I want dropped, pasted and picked files to become chips with a destination
 *             I can change, a sixth file to be refused by name, and the upload result shown per chip.
 * ARCHITECTURE:
 *   - The repo has no DOM test runner (a test cannot import a .tsx), so the component's state is
 *     tested through its pure transitions (`chat-attachments-view.ts`), with the same sniff the
 *     component runs on the File's bytes. Drop, paste and the Attach button all call the hook's one
 *     `add(files)`, which is `admit` + `sniffed` below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admit, sniffed, chooseDestination, removeChip, sendable, checking, applyResults, chipLabel, sameOriginPath, type Chip } from './chat-attachments-view.ts';
import { sniffBytes } from '../runtime/chat-attachments.ts';

const enc = (s: string) => new TextEncoder().encode(s);
let n = 0;
const key = () => `k${(n += 1)}`;
const f = (name: string, size = 10) => ({ name, size });

test('drop / paste / attach: files are admitted as checking chips, then the sniff pre-selects a destination', () => {
  n = 0;
  const { chips, admitted, notice } = admit([], [f('sales.csv'), f('deck.pdf'), f('notes.md')], key);
  assert.equal(notice, '');
  assert.equal(admitted.length, 3);
  assert.ok(checking(chips));
  let c = sniffed(chips, 'k1', sniffBytes('sales.csv', enc('a,b\n1,2\n')));
  c = sniffed(c, 'k2', sniffBytes('deck.pdf', enc('%PDF-1.4 x')));
  c = sniffed(c, 'k3', sniffBytes('notes.md', enc('# hi')));
  assert.deepEqual(c.map((x) => [x.state, x.destination]), [['ready', 'data'], ['ready', 'files'], ['ready', 'knowledge']]);
  assert.equal(checking(c), false);
  assert.equal(chipLabel(c[0]), 'sales.csv: will go to Data');
});

test('the 6th file is not attached, and is named in the notice', () => {
  n = 0;
  const four = admit([], [f('1.csv'), f('2.csv'), f('3.csv'), f('4.csv')], key).chips;
  const { chips, admitted, notice } = admit(four, [f('5.csv'), f('6.csv')], key);
  assert.equal(chips.length, 5);
  assert.equal(admitted.length, 1);
  assert.match(notice, /at most 5 files — not attached: 6\.csv\./);
});

test('destination change: allowed choices are taken, others ignored; a refused chip is never sent', () => {
  n = 0;
  let c: Chip[] = admit([], [f('sales.csv'), f('x.exe')], key).chips;
  c = sniffed(c, 'k1', sniffBytes('sales.csv', enc('a,b\n1,2\n')));
  c = sniffed(c, 'k2', sniffBytes('x.exe', new Uint8Array([0x4d, 0x5a, 0, 0, 0xff])));
  c = chooseDestination(c, 'k1', 'files');
  assert.equal(c[0].destination, 'files');
  c = chooseDestination(c, 'k1', 'knowledge'); // a CSV cannot be a knowledge note
  assert.equal(c[0].destination, 'files');
  assert.equal(c[1].state, 'refused');
  assert.match(chipLabel(c[1]), /x\.exe: .*not a supported file type/);
  assert.deepEqual(sendable(c).map((x) => x.key), ['k1']);
  assert.deepEqual(removeChip(c, 'k2').map((x) => x.key), ['k1']);
});

test('the server’s results are shown per chip: created links to the item, a refusal says why', () => {
  n = 0;
  let c: Chip[] = admit([], [f('a.csv'), f('b.md')], key).chips;
  c = sniffed(c, 'k1', sniffBytes('a.csv', enc('a,b\n1,2\n')));
  c = sniffed(c, 'k2', sniffBytes('b.md', enc('# b')));
  c = applyResults(c, ['k1', 'k2'], [
    { name: 'a.csv', destination: 'data', outcome: 'created', message: '', item: { type: 'dataset', id: 'ds_1', title: 'a', href: '/data?focus=ds_1', detail: 'Bronze landed: 1 rows' } },
    { name: 'b.md', destination: 'knowledge', outcome: 'denied', message: 'Policy did not allow it.' },
  ]);
  assert.equal(c[0].state, 'done');
  assert.equal(c[0].href, '/data?focus=ds_1');
  assert.equal(chipLabel(c[0]), 'a.csv: uploaded to Data');
  assert.equal(c[1].state, 'failed');
  assert.equal(c[1].message, 'Policy did not allow it.');
});

test('a chip links only to an in-OS path', () => {
  assert.equal(sameOriginPath('/data?focus=ds_1'), '/data?focus=ds_1');
  assert.equal(sameOriginPath('//evil.example/x'), undefined);
  assert.equal(sameOriginPath('/\\evil.example'), undefined);
  assert.equal(sameOriginPath('javascript:alert(1)'), undefined);
  assert.equal(sameOriginPath('https://evil.example'), undefined);
});

test('names shown on chips are sanitised', () => {
  n = 0;
  const { chips } = admit([], [f('../../x/‮evil.csv')], key);
  assert.equal(chips[0].name, 'evil.csv');
});
