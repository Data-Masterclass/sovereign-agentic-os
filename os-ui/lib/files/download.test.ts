/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textDownloadName, safeDispositionName, absentOriginalNote } from './download.ts';

// ---- text-only download filename ----

test('textDownloadName keeps an already-textual name unchanged', () => {
  assert.equal(textDownloadName('notes.txt'), 'notes.txt');
  assert.equal(textDownloadName('data.csv'), 'data.csv');
  assert.equal(textDownloadName('log.json'), 'log.json');
});

test('textDownloadName appends .txt to a non-text name (honest about extracted text)', () => {
  assert.equal(textDownloadName('report.pdf'), 'report.pdf.txt');
  assert.equal(textDownloadName('clip.m4a'), 'clip.m4a.txt');
});

test('textDownloadName never returns an empty name', () => {
  assert.equal(textDownloadName(''), 'file.txt');
  assert.equal(textDownloadName('   '), 'file.txt');
});

// ---- Content-Disposition safety ----

test('safeDispositionName strips quotes and newlines that would break the header', () => {
  assert.equal(safeDispositionName('a"b'), "a'b");
  assert.equal(safeDispositionName('a\r\nb'), 'ab');
});

// ---- absent-original note is never empty ----

test('absentOriginalNote returns a non-empty, honest note mentioning the file name', () => {
  const note = absentOriginalNote('mystery.bin');
  assert.ok(note.length > 0);
  assert.match(note, /mystery\.bin/);
  assert.match(note, /re-upload/i);
});
