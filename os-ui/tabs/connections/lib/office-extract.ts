/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    Read Excel (.xlsx) sheets as a table and Word (.docx) files as text, with no dependency
 * USER STORY: As a user I want the chat to read budget.xlsx from my OneDrive or Google Drive and turn
 *             a sheet into a dataset, and to read a Word document, without the OS shipping a big parser —
 *             and without a hostile file being able to stall or crash the OS.
 * ARCHITECTURE:
 *   - Pure, node `zlib` only. An Office file is a ZIP of XML parts: this reads the central directory,
 *     inflates the few parts it needs, and walks the XML with a linear `indexOf` scanner (no lazy
 *     `[\s\S]*?` regular expressions, which are quadratic on a crafted file).
 *   - Hostile input is bounded, and every refusal is an `OfficeExtractError`:
 *       · zip offsets and sizes are checked against the buffer; an inflated part is capped at
 *         `MAX_PART_BYTES` (a zip bomb is refused, not inflated);
 *       · row and column numbers are clamped to Excel's own maximum (1,048,576 × 16,384); rows are
 *         kept sparse, so `<row r="300000000">` allocates nothing;
 *       · the table may hold at most `MAX_CELLS` cells (width × rows) and the parse has a time budget
 *         (`TIME_BUDGET_MS`), checked as it scans;
 *       · an invalid character reference (`&#x110000;`) is an error, not a crash.
 *   - Header detection: the first non-empty row (or the `headerRow` asked for) names the columns;
 *     blank names become `column_<n>`, duplicates get a numeric suffix. Cells with a date number
 *     format become ISO dates; everything else is kept as text, so nothing is guessed silently.
 *   - Used by `account-tools.ts` (file_read, table export); the dataset ingest then runs the same
 *     governed path as an upload (`ingest_dataset`).
 */
import { inflateRawSync } from 'zlib';

export const MAX_PART_BYTES = 32 * 1024 * 1024;
/** Excel's own limits. */
export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLS = 16_384;
/** The most cells (columns × rows) one extracted table may hold. */
export const MAX_CELLS = 2_000_000;
/** How long one parse may take before it is refused. */
export const TIME_BUDGET_MS = 5_000;

export class OfficeExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeExtractError';
  }
}

/** A deadline checked while scanning. */
function budget(ms = TIME_BUDGET_MS): () => void {
  const end = Date.now() + ms;
  let n = 0;
  return () => {
    if ((++n & 1023) === 0 && Date.now() > end) throw new OfficeExtractError(`The file took longer than ${ms / 1000} s to read; it is refused.`);
  };
}

type ZipEntry = { name: string; method: number; compSize: number; size: number; offset: number };

function entries(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new OfficeExtractError('The file is not a valid Office (zip) document.');
  // End of central directory: the last 0x06054b50 within the final 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new OfficeExtractError('The file is not a valid Office (zip) document.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p < 0 || p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new OfficeExtractError('The document\'s zip directory is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new OfficeExtractError('The document\'s zip directory is damaged.');
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The inflated text of one part of the zip, or null when the part is absent. */
export function readZipPart(buf: Buffer, name: string, all: ZipEntry[] = entries(buf)): string | null {
  const e = all.find((x) => x.name === name);
  if (!e) return null;
  if (e.size > MAX_PART_BYTES) throw new OfficeExtractError(`The part ${name} is larger than ${MAX_PART_BYTES / 1048576} MB.`);
  const h = e.offset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new OfficeExtractError('The document\'s zip entry is damaged.');
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  if (start + e.compSize > buf.length) throw new OfficeExtractError('The document\'s zip entry points outside the file.');
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method === 8) {
    let out: Buffer;
    try {
      out = inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES });
    } catch (err) {
      throw new OfficeExtractError(`The part ${name} could not be decompressed (or is too large): ${(err as Error).message}`);
    }
    return out.toString('utf8');
  }
  throw new OfficeExtractError(`Unsupported zip compression method ${e.method}.`);
}

export function decodeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|amp|lt|gt|quot|apos);/gi, (_m, g: string) => {
    const k = g.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new OfficeExtractError(`The document holds an invalid character reference (&${g};).`);
    }
    return String.fromCodePoint(code);
  });
}

/** The value of `name="…"` in one open tag (a short string), or null. */
function attr(tag: string, name: string): string | null {
  const key = ` ${name}="`;
  let i = tag.indexOf(key);
  if (i < 0) {
    // attributes may be separated by tabs/newlines
    const m = new RegExp(`\\s${name.replace(/[^A-Za-z:]/g, '')}="`).exec(tag);
    if (!m) return null;
    i = m.index;
  }
  const start = tag.indexOf('"', i) + 1;
  const end = tag.indexOf('"', start);
  return end < 0 ? null : decodeXml(tag.slice(start, end));
}

/**
 * Visit every element named `tag` in `xml` (linear `indexOf` scan). `fn` gets the open tag and the
 * inner text ('' for a self-closing element). Nested elements of the same name are not expected in
 * the parts read here.
 */
function eachElement(xml: string, tag: string, fn: (open: string, inner: string) => void, tick: () => void, from = 0, to = xml.length): void {
  const openTok = `<${tag}`;
  const closeTok = `</${tag}>`;
  let pos = from;
  for (;;) {
    tick();
    const i = xml.indexOf(openTok, pos);
    if (i < 0 || i >= to) return;
    const after = xml.charCodeAt(i + openTok.length);
    // must be the whole name: `<c ` / `<c>` / `<c/`, not `<col`
    if (!(after === 32 || after === 62 || after === 47 || after === 9 || after === 10 || after === 13)) { pos = i + openTok.length; continue; }
    const gt = xml.indexOf('>', i);
    if (gt < 0 || gt >= to) return;
    const open = xml.slice(i, gt + 1);
    if (xml.charCodeAt(gt - 1) === 47) { fn(open, ''); pos = gt + 1; continue; }
    const close = xml.indexOf(closeTok, gt + 1);
    if (close < 0 || close > to) return;
    fn(open, xml.slice(gt + 1, close));
    pos = close + closeTok.length;
  }
}

/** All `<t>` texts inside a fragment, joined (shared strings and inline strings). */
function texts(fragment: string, tick: () => void): string {
  let out = '';
  eachElement(fragment, 't', (_o, inner) => { out += decodeXml(inner); }, tick);
  return out;
}

// ------------------------------------------------------------------ xlsx ---

export type SheetTable = {
  sheet: string;
  sheetNames: string[];
  columns: string[];
  rows: string[][];
  /** Rows in the sheet below the header, before the row cap. */
  totalRows: number;
  truncated: boolean;
};

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(stylesXml: string | null, tick: () => void): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  eachElement(stylesXml, 'numFmt', (open) => { custom.set(Number(attr(open, 'numFmtId')), attr(open, 'formatCode') ?? ''); }, tick);
  const a = stylesXml.indexOf('<cellXfs');
  const b = a < 0 ? -1 : stylesXml.indexOf('</cellXfs>', a);
  if (a < 0 || b < 0) return out;
  let i = 0;
  eachElement(stylesXml, 'xf', (open) => {
    const id = Number(attr(open, 'numFmtId') ?? '0');
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
    if (BUILTIN_DATE_FMTS.has(id) || (/[dy]/.test(code) && !/^[#0.,%\s]*$/.test(code))) out.add(i);
    i += 1;
  }, tick, a, b);
  return out;
}

/** Excel serial day number → ISO date (time kept when present). 1900 system. Out of range → null. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null; // up to 9999-12-31
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const iso = new Date(ms).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
}

/** 0-based column of a cell ref (`A1` → 0), or -1 when it is beyond Excel's last column. */
function colIndex(ref: string): number {
  let n = 0;
  let k = 0;
  for (; k < ref.length && k < 4; k++) {
    const c = ref.charCodeAt(k);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  if (k === 0) return -2; // no letters: position by order
  return n >= 1 && n <= EXCEL_MAX_COLS ? n - 1 : -1;
}

function uniqueColumns(header: string[]): string[] {
  const seen = new Map<string, number>();
  return header.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
}

const nonEmpty = (r: string[] | undefined): boolean => !!r && r.some((c) => (c ?? '').trim() !== '');

/**
 * Read one sheet of an .xlsx file as a table. `sheet` is a sheet name (default: the first);
 * `headerRow` is 1-based (default: the first non-empty row).
 */
export function readXlsxSheet(buf: Buffer, opts: { sheet?: string; headerRow?: number; maxRows?: number; timeBudgetMs?: number } = {}): SheetTable {
  const tick = budget(opts.timeBudgetMs);
  const all = entries(buf);
  const workbook = readZipPart(buf, 'xl/workbook.xml', all);
  if (!workbook) throw new OfficeExtractError('This is not an Excel workbook (.xlsx).');
  const rels = readZipPart(buf, 'xl/_rels/workbook.xml.rels', all) ?? '';
  const relTarget = new Map<string, string>();
  eachElement(rels, 'Relationship', (open) => {
    const id = attr(open, 'Id');
    const target = attr(open, 'Target');
    if (id && target) relTarget.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }, tick);
  const sheets: { name: string; path: string }[] = [];
  eachElement(workbook, 'sheet', (open) => {
    const name = attr(open, 'name') ?? '';
    const rid = attr(open, 'r:id');
    const path = rid ? relTarget.get(rid) : undefined;
    if (name && path) sheets.push({ name, path });
  }, tick);
  if (sheets.length === 0) throw new OfficeExtractError('The workbook has no sheets.');
  const pick = opts.sheet ? sheets.find((s) => s.name.toLowerCase() === opts.sheet!.toLowerCase()) : sheets[0];
  if (!pick) throw new OfficeExtractError(`The workbook has no sheet "${opts.sheet}". Sheets: ${sheets.map((s) => s.name).join(', ')}.`);

  const shared: string[] = [];
  const ss = readZipPart(buf, 'xl/sharedStrings.xml', all);
  if (ss) eachElement(ss, 'si', (_o, inner) => { shared.push(texts(inner, tick)); }, tick);
  const dates = dateStyles(readZipPart(buf, 'xl/styles.xml', all), tick);
  const xml = readZipPart(buf, pick.path, all);
  if (!xml) throw new OfficeExtractError(`The sheet "${pick.name}" could not be found in the file.`);

  // Sparse: row number → cells. Nothing is allocated for the rows a file skips.
  const grid = new Map<number, string[]>();
  let width = 0;
  let cells = 0;
  let nextRow = 1;
  eachElement(xml, 'row', (rowOpen, rowInner) => {
    const rAttr = attr(rowOpen, 'r');
    const rowNo = rAttr === null ? nextRow : Number(rAttr);
    if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > EXCEL_MAX_ROWS) throw new OfficeExtractError(`The sheet has a row number outside Excel's range (${String(rAttr).slice(0, 20)}).`);
    nextRow = rowNo + 1;
    const row: string[] = [];
    eachElement(rowInner, 'c', (open, inner) => {
      const ref = attr(open, 'r') ?? '';
      let idx = ref ? colIndex(ref) : -2;
      if (idx === -1) throw new OfficeExtractError(`The sheet has a cell beyond Excel's last column (${ref.slice(0, 12)}).`);
      if (idx === -2) idx = row.length;
      const t = attr(open, 't') ?? 'n';
      const s = Number(attr(open, 's') ?? '-1');
      const vs = inner.indexOf('<v>');
      const ve = vs < 0 ? -1 : inner.indexOf('</v>', vs);
      const v = vs >= 0 && ve > vs ? inner.slice(vs + 3, ve) : undefined;
      let value = '';
      if (t === 's') value = v !== undefined ? (shared[Number(v)] ?? '') : '';
      else if (t === 'inlineStr') value = texts(inner, tick);
      else if (t === 'b') value = v === '1' ? 'true' : v === '0' ? 'false' : '';
      else if (v !== undefined) {
        const raw = decodeXml(v);
        const iso = t === 'n' && dates.has(s) && raw !== '' ? excelSerialToIso(Number(raw)) : null;
        value = iso ?? raw;
      }
      if (value === '') return; // empty cells stay holes
      row[idx] = value;
      if (idx + 1 > width) width = idx + 1;
      cells += 1;
      if (cells > MAX_CELLS) throw new OfficeExtractError(`The sheet has more than ${MAX_CELLS.toLocaleString('en')} cells; it is too large to import here.`);
    }, tick);
    if (row.length) grid.set(rowNo, row);
  }, tick);

  const rowNos = [...grid.keys()].sort((a, b) => a - b);
  const headerNo = opts.headerRow && opts.headerRow > 0 ? opts.headerRow : rowNos.find((n) => nonEmpty(grid.get(n)));
  if (headerNo === undefined || !grid.has(headerNo)) {
    return { sheet: pick.name, sheetNames: sheets.map((s) => s.name), columns: [], rows: [], totalRows: 0, truncated: false };
  }
  const bodyNos = rowNos.filter((n) => n > headerNo && nonEmpty(grid.get(n)));
  const maxRows = opts.maxRows ?? 50_000;
  if (width * Math.min(bodyNos.length + 1, maxRows + 1) > MAX_CELLS) {
    throw new OfficeExtractError(`The table would be ${width} columns × ${Math.min(bodyNos.length, maxRows)} rows, more than ${MAX_CELLS.toLocaleString('en')} cells.`);
  }
  const dense = (r: string[] | undefined): string[] => {
    const out = new Array<string>(width);
    for (let i = 0; i < width; i++) out[i] = r?.[i] ?? '';
    return out;
  };
  return {
    sheet: pick.name,
    sheetNames: sheets.map((s) => s.name),
    columns: uniqueColumns(dense(grid.get(headerNo))),
    rows: bodyNos.slice(0, maxRows).map((n) => dense(grid.get(n))),
    totalRows: bodyNos.length,
    truncated: bodyNos.length > maxRows,
  };
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A table as CSV, cut at `maxBytes` on a row boundary (reported). Linear: a running byte count. */
export function tableToCsv(columns: string[], rows: string[][], maxBytes: number): { csv: string; rows: number; truncated: boolean } {
  const head = `${columns.map(csvCell).join(',')}\n`;
  const parts: string[] = [head];
  let bytes = Buffer.byteLength(head, 'utf8');
  let n = 0;
  for (const r of rows) {
    const line = `${r.map(csvCell).join(',')}\n`;
    const lb = Buffer.byteLength(line, 'utf8');
    if (bytes + lb > maxBytes) return { csv: parts.join(''), rows: n, truncated: true };
    parts.push(line);
    bytes += lb;
    n += 1;
  }
  return { csv: parts.join(''), rows: n, truncated: false };
}

/** Parse CSV text into header + rows (RFC 4180 quoting). Used for Google Sheets' CSV export. */
export function parseCsv(text: string, maxRows = 50_000): { columns: string[]; rows: string[][]; totalRows: number; truncated: boolean } {
  const tick = budget();
  const records: string[][] = [];
  let field = '';
  let rec: string[] = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    tick();
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { rec.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      rec.push(field); field = '';
      records.push(rec); rec = [];
    } else field += ch;
    if (rec.length > EXCEL_MAX_COLS) throw new OfficeExtractError(`A CSV row has more than ${EXCEL_MAX_COLS} columns.`);
  }
  if (field !== '' || rec.length) { rec.push(field); records.push(rec); }
  const kept = records.filter((r) => r.some((c) => c.trim() !== ''));
  if (kept.length === 0) return { columns: [], rows: [], totalRows: 0, truncated: false };
  const [head, ...body] = kept;
  let width = head.length;
  for (const r of body) if (r.length > width) width = r.length;
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '');
  return {
    columns: uniqueColumns(pad(head)),
    rows: body.slice(0, maxRows).map(pad),
    totalRows: body.length,
    truncated: body.length > maxRows,
  };
}

// ------------------------------------------------------------------ docx ---

/** The text of a .docx file: one line per paragraph, tabs kept. */
export function readDocxText(buf: Buffer, opts: { timeBudgetMs?: number } = {}): string {
  const tick = budget(opts.timeBudgetMs);
  const doc = readZipPart(buf, 'word/document.xml');
  if (!doc) throw new OfficeExtractError('This is not a Word document (.docx).');
  const paras: string[] = [];
  eachElement(doc, 'w:p', (_open, inner) => {
    // Runs in document order: text, tabs and breaks, by a linear scan for the next '<'.
    let line = '';
    let pos = 0;
    for (;;) {
      tick();
      const i = inner.indexOf('<w:', pos);
      if (i < 0) break;
      if (inner.startsWith('<w:tab/>', i)) { line += '\t'; pos = i + 8; continue; }
      if (inner.startsWith('<w:br/>', i)) { line += '\n'; pos = i + 7; continue; }
      if (inner.startsWith('<w:t>', i) || inner.startsWith('<w:t ', i)) {
        const gt = inner.indexOf('>', i);
        const end = inner.indexOf('</w:t>', gt);
        if (gt < 0 || end < 0) break;
        if (inner.charCodeAt(gt - 1) !== 47) line += decodeXml(inner.slice(gt + 1, end));
        pos = end + 6;
        continue;
      }
      pos = i + 3;
    }
    paras.push(line);
  }, tick);
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
