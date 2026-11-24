/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests — Excel and Word reading for the chat
 * USER STORY: As a maintainer I want proof that a sheet becomes the right table and that a bad file is refused plainly.
 * ARCHITECTURE: real `office-extract.ts` against files built by `core/testing/account-fixtures.ts`; each behaviour
 *   with its negative twin: sheets and header detection, dates, reported row caps, CSV quoting and the byte cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsxSheet, readDocxText, tableToCsv, parseCsv, excelSerialToIso, OfficeExtractError } from './office-extract.ts';
import { xlsx, docx, zip } from '../../../core/testing/account-fixtures.ts';

const budget = xlsx({
  Summary: [['Total', 1200]],
  'Budget 2026': [
    [null, null, null],
    ['Cost centre', 'Amount', 'Due'],
    ['Marketing', 500, { date: 46023 }],
    ['R&D, Labs', 700.5, { date: 46054 }],
    ['', '', ''],
  ],
}, { deflate: true });

test('reads the named sheet, finds the header below a blank row, converts date cells, skips empty rows', () => {
  const t = readXlsxSheet(budget, { sheet: 'budget 2026' });
  assert.equal(t.sheet, 'Budget 2026');
  assert.deepEqual(t.sheetNames, ['Summary', 'Budget 2026']);
  assert.deepEqual(t.columns, ['Cost centre', 'Amount', 'Due']);
  assert.deepEqual(t.rows, [['Marketing', '500', '2026-01-01'], ['R&D, Labs', '700.5', '2026-02-01']]);
  assert.equal(t.totalRows, 2);
  assert.equal(t.truncated, false);
});

test('TWIN: the default is the first sheet; an unknown sheet is refused with the sheet names', () => {
  assert.deepEqual(readXlsxSheet(budget).columns, ['Total', '1200']);
  assert.throws(() => readXlsxSheet(budget, { sheet: 'Nope' }), (e: Error) => e instanceof OfficeExtractError && /Summary, Budget 2026/.test(e.message));
});

test('an explicit header row wins; blank and duplicate header names are made unique', () => {
  const book = xlsx({ S: [['a', '', 'a'], ['1', '2', '3']] });
  assert.deepEqual(readXlsxSheet(book, { headerRow: 1 }).columns, ['a', 'column_2', 'a_2']);
});

test('the row cap is reported, never silent', () => {
  const rows: (string | number)[][] = [['n']];
  for (let i = 0; i < 30; i++) rows.push([i]);
  const t = readXlsxSheet(xlsx({ S: rows }), { maxRows: 10 });
  assert.equal(t.rows.length, 10);
  assert.equal(t.totalRows, 30);
  assert.equal(t.truncated, true);
});

test('CSV quotes commas and quotes, and is cut on a row boundary at the byte cap', () => {
  const full = tableToCsv(['a', 'b'], [['x,y', 'say "hi"'], ['2', '3']], 1000);
  assert.equal(full.csv, 'a,b\n"x,y","say ""hi"""\n2,3\n');
  assert.equal(full.truncated, false);
  const cut = tableToCsv(['a'], [['1'], ['2'], ['3']], 5);
  assert.equal(cut.csv, 'a\n1\n');
  assert.equal(cut.rows, 1);
  assert.equal(cut.truncated, true);
  assert.deepEqual(parseCsv(full.csv).rows, [['x,y', 'say "hi"'], ['2', '3']]);
});

test('Word: one line per paragraph, entities decoded', () => {
  assert.equal(readDocxText(docx(['Decision: ship Q3', 'Owner: Anna & Ben'])), 'Decision: ship Q3\nOwner: Anna & Ben');
});

test('TWIN: a non-Office file and a zip without the part are refused in plain words', () => {
  assert.throws(() => readXlsxSheet(Buffer.from('not a zip at all, just text')), /not a valid Office/);
  assert.throws(() => readXlsxSheet(zip({ 'word/document.xml': '<w:document/>' })), /not an Excel workbook/);
  assert.throws(() => readDocxText(budget), /not a Word document/);
});

test('Excel serial dates', () => {
  assert.equal(excelSerialToIso(45658), '2025-01-01');
  assert.equal(excelSerialToIso(45658.5), '2025-01-01T12:00:00Z');
});
