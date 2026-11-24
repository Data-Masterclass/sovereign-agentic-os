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
import { readXlsxSheet, readDocxText, tableToCsv, parseCsv, excelSerialToIso, decodeXml, OfficeExtractError } from './office-extract.ts';
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

// ---------------------------------------------------------------- hostile files ---

/** A workbook whose one sheet is the given raw XML. */
const rawSheet = (sheetXml: string, extra: Record<string, string> = {}) => zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': sheetXml,
  ...extra,
}, { deflate: true });
const refused = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof OfficeExtractError && re.test(e.message));

test('HOSTILE: a row number beyond Excel\'s range is refused, and a far-away valid row allocates nothing', () => {
  refused(() => readXlsxSheet(rawSheet('<sheetData><row r="300000000"><c r="A300000000" t="inlineStr"><is><t>x</t></is></c></row></sheetData>')), /row number outside/);
  const t = readXlsxSheet(rawSheet('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row><row r="1048576"><c r="A1048576" t="inlineStr"><is><t>v</t></is></c></row></sheetData>'));
  assert.deepEqual([t.columns, t.rows], [['h'], [['v']]]);
});

test('HOSTILE: a column beyond XFD is refused; a wide-but-legal sheet is capped by the cell budget', () => {
  refused(() => readXlsxSheet(rawSheet('<sheetData><row r="1"><c r="ZZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row></sheetData>')), /last column/);
  // XFD (16384 columns) x 200 rows = 3.3M cells > the 2M budget
  let rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c><c r="XFD1" t="inlineStr"><is><t>z</t></is></c></row>';
  for (let r = 2; r < 200; r++) rows += `<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`;
  refused(() => readXlsxSheet(rawSheet(`<sheetData>${rows}</sheetData>`)), /cells/);
});

test('HOSTILE: unclosed elements and long runs of open tags are linear, not quadratic', () => {
  const opens = '<c r="A1">'.repeat(200_000);
  const t0 = Date.now();
  const t = readXlsxSheet(rawSheet(`<sheetData><row r="1">${opens}</row></sheetData>`, { 'xl/sharedStrings.xml': `<sst>${'<si>'.repeat(200_000)}</sst>` }));
  assert.equal(t.columns.length, 0);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  const t1 = Date.now();
  readXlsxSheet(rawSheet(`<sheetData>${'<row r="1">'.repeat(200_000)}</sheetData>`));
  assert.ok(Date.now() - t1 < 3000);
  const t2 = Date.now();
  readDocxText(zip({ 'word/document.xml': `<w:document><w:body>${'<w:p><w:t>'.repeat(100_000)}</w:body></w:document>` }));
  assert.ok(Date.now() - t2 < 3000);
});

test('HOSTILE: the time budget refuses a slow parse', () => {
  let rows = '';
  for (let r = 1; r <= 3000; r++) rows += `<row r="${r}"><c r="A${r}"><v>${r}</v></c></row>`;
  refused(() => readXlsxSheet(rawSheet(`<sheetData>${rows}</sheetData>`), { timeBudgetMs: -1 }), /longer than/);
});

test('HOSTILE: an invalid character reference and a zip pointing outside the file are refused', () => {
  refused(() => decodeXml('&#x110000;'), /invalid character reference/);
  refused(() => decodeXml('&#xD800;'), /invalid character reference/);
  assert.equal(decodeXml('&#x1F600;'), '\u{1F600}');
  const bad = Buffer.from(rawSheet('<sheetData/>'));
  const eocd = bad.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cd = bad.readUInt32LE(eocd + 16);
  bad.writeUInt32LE(0x7fffffff, cd + 42); // the first entry's local-header offset
  refused(() => readXlsxSheet(bad), /damaged|outside/);
});

test('an out-of-range date serial is kept as the raw number, not a crash', () => {
  assert.equal(excelSerialToIso(1e12), null);
  const t = readXlsxSheet(xlsx({ S: [['d'], [{ date: 99999999 }]] }));
  assert.deepEqual(t.rows, [['99999999']]);
});

test('tableToCsv stays linear on many rows', () => {
  const rows = Array.from({ length: 200_000 }, (_, i) => [String(i), 'x']);
  const t0 = Date.now();
  const out = tableToCsv(['a', 'b'], rows, 2 * 1024 * 1024);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(out.rows, 200_000);
});
