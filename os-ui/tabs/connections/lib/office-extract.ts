/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    Read Excel (.xlsx) sheets as a table and Word (.docx) files as text, with no dependency
 * USER STORY: As a user I want the chat to read budget.xlsx from my OneDrive or Google Drive and turn
 *             a sheet into a dataset, and to read a Word document, without the OS shipping a big parser.
 * ARCHITECTURE:
 *   - Pure, node `zlib` only. An Office file is a ZIP of XML parts: this reads the central directory,
 *     inflates the few parts it needs, and parses them with small, bounded regular expressions.
 *   - Bounded on purpose: at most `MAX_PART_BYTES` per inflated part (a zip bomb is refused, not
 *     inflated), `maxRows` rows per sheet. A truncated result says so (`truncated: true`).
 *   - Header detection: the first non-empty row (or the `headerRow` asked for) names the columns;
 *     blank names become `column_<n>`, duplicates get a numeric suffix. Cells with a date number
 *     format become ISO dates; everything else is kept as text, so nothing is guessed silently.
 *   - Used by `account-tools.ts` (file_read, table export); the dataset ingest then runs the same
 *     governed path as an upload (`ingest_dataset`).
 */
import { inflateRawSync } from 'zlib';

export const MAX_PART_BYTES = 32 * 1024 * 1024;

export class OfficeExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeExtractError';
  }
}

type ZipEntry = { name: string; method: number; compSize: number; size: number; offset: number };

function entries(buf: Buffer): ZipEntry[] {
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
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new OfficeExtractError('The document\'s zip directory is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
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
  if (buf.readUInt32LE(h) !== 0x04034b50) throw new OfficeExtractError('The document\'s zip entry is damaged.');
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString('utf8');
    } catch {
      throw new OfficeExtractError(`The part ${name} could not be decompressed (or is too large).`);
    }
  }
  throw new OfficeExtractError(`Unsupported zip compression method ${e.method}.`);
}

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, g: string) => {
    const k = g.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
};

/** All `<t>` texts inside a fragment, joined (shared strings and inline strings). */
function texts(fragment: string): string {
  let out = '';
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
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

function dateStyles(stylesXml: string | null): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode') ?? '';
    custom.set(id, code);
  }
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\s[^>]*?\/?>/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? '0');
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
    if (BUILTIN_DATE_FMTS.has(id) || (/[dy]/.test(code) && !/^[#0.,%\s]*$/.test(code))) out.add(i);
    i += 1;
  }
  return out;
}

/** Excel serial day number → ISO date (time kept when present). 1900 system. */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const iso = new Date(ms).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
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

/**
 * Read one sheet of an .xlsx file as a table. `sheet` is a sheet name (default: the first);
 * `headerRow` is 1-based (default: the first non-empty row).
 */
export function readXlsxSheet(buf: Buffer, opts: { sheet?: string; headerRow?: number; maxRows?: number } = {}): SheetTable {
  const all = entries(buf);
  const workbook = readZipPart(buf, 'xl/workbook.xml', all);
  if (!workbook) throw new OfficeExtractError('This is not an Excel workbook (.xlsx).');
  const rels = readZipPart(buf, 'xl/_rels/workbook.xml.rels', all) ?? '';
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relTarget.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sheets: { name: string; path: string }[] = [];
  for (const m of workbook.matchAll(/<sheet\s[^>]*\/?>/g)) {
    const name = attr(m[0], 'name') ?? '';
    const rid = attr(m[0], 'r:id');
    const path = rid ? relTarget.get(rid) : undefined;
    if (name && path) sheets.push({ name, path });
  }
  if (sheets.length === 0) throw new OfficeExtractError('The workbook has no sheets.');
  const pick = opts.sheet ? sheets.find((s) => s.name.toLowerCase() === opts.sheet!.toLowerCase()) : sheets[0];
  if (!pick) throw new OfficeExtractError(`The workbook has no sheet "${opts.sheet}". Sheets: ${sheets.map((s) => s.name).join(', ')}.`);

  const shared: string[] = [];
  const ss = readZipPart(buf, 'xl/sharedStrings.xml', all);
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(m[1]));
  const dates = dateStyles(readZipPart(buf, 'xl/styles.xml', all));
  const xml = readZipPart(buf, pick.path, all);
  if (!xml) throw new OfficeExtractError(`The sheet "${pick.name}" could not be found in the file.`);

  const grid: string[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNo = Number(attr(rm[0].slice(0, rm[0].indexOf('>') + 1), 'r') ?? grid.length + 1);
    const cells: string[] = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const open = `<c${cm[1]}>`;
      const ref = attr(open, 'r') ?? '';
      const t = attr(open, 't') ?? 'n';
      const s = Number(attr(open, 's') ?? '-1');
      const inner = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (t === 's') value = v !== undefined ? (shared[Number(v)] ?? '') : '';
      else if (t === 'inlineStr') value = texts(inner);
      else if (t === 'b') value = v === '1' ? 'true' : v === '0' ? 'false' : '';
      else if (v !== undefined) {
        const raw = decodeXml(v);
        value = t === 'n' && dates.has(s) && raw !== '' && Number.isFinite(Number(raw)) ? excelSerialToIso(Number(raw)) : raw;
      }
      const idx = ref ? colIndex(ref) : cells.length;
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    while (grid.length < rowNo - 1) grid.push([]);
    grid[rowNo - 1] = cells;
  }

  const headerIdx = opts.headerRow && opts.headerRow > 0
    ? opts.headerRow - 1
    : grid.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (headerIdx < 0 || !grid[headerIdx]) {
    return { sheet: pick.name, sheetNames: sheets.map((s) => s.name), columns: [], rows: [], totalRows: 0, truncated: false };
  }
  const body = grid.slice(headerIdx + 1).filter((r) => r && r.some((c) => (c ?? '').trim() !== ''));
  const width = Math.max(grid[headerIdx].length, ...body.map((r) => r.length));
  const header = Array.from({ length: width }, (_, i) => grid[headerIdx][i] ?? '');
  const maxRows = opts.maxRows ?? 50_000;
  const rows = body.slice(0, maxRows).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return {
    sheet: pick.name,
    sheetNames: sheets.map((s) => s.name),
    columns: uniqueColumns(header),
    rows,
    totalRows: body.length,
    truncated: body.length > maxRows,
  };
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A table as CSV, cut at `maxBytes` on a row boundary (reported). */
export function tableToCsv(columns: string[], rows: string[][], maxBytes: number): { csv: string; rows: number; truncated: boolean } {
  let csv = `${columns.map(csvCell).join(',')}\n`;
  let n = 0;
  for (const r of rows) {
    const line = `${r.map(csvCell).join(',')}\n`;
    if (Buffer.byteLength(csv, 'utf8') + Buffer.byteLength(line, 'utf8') > maxBytes) return { csv, rows: n, truncated: true };
    csv += line;
    n += 1;
  }
  return { csv, rows: n, truncated: false };
}

/** Parse CSV text into header + rows (RFC 4180 quoting). Used for Google Sheets' CSV export. */
export function parseCsv(text: string, maxRows = 50_000): { columns: string[]; rows: string[][]; totalRows: number; truncated: boolean } {
  const records: string[][] = [];
  let field = '';
  let rec: string[] = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
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
  }
  if (field !== '' || rec.length) { rec.push(field); records.push(rec); }
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return { columns: [], rows: [], totalRows: 0, truncated: false };
  const [head, ...body] = nonEmpty;
  const width = Math.max(head.length, ...body.map((r) => r.length));
  return {
    columns: uniqueColumns(Array.from({ length: width }, (_, i) => head[i] ?? '')),
    rows: body.slice(0, maxRows).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
    totalRows: body.length,
    truncated: body.length > maxRows,
  };
}

// ------------------------------------------------------------------ docx ---

/** The text of a .docx file: one line per paragraph, tabs kept. */
export function readDocxText(buf: Buffer): string {
  const doc = readZipPart(buf, 'word/document.xml');
  if (!doc) throw new OfficeExtractError('This is not a Word document (.docx).');
  const paras: string[] = [];
  for (const m of doc.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    let line = '';
    for (const t of m[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      if (t[0] === '<w:tab/>') line += '\t';
      else if (t[0] === '<w:br/>') line += '\n';
      else line += decodeXml(t[1]);
    }
    paras.push(line);
  }
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
