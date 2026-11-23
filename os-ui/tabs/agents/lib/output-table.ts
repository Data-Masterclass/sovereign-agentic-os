/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The table contract of a Data output — what a result must contain to become a dataset
 * USER STORY: As an author I declared a Dataset under "Where the results go". When my agent
 *             returns its rows, they become that dataset. When it returns prose, nothing is
 *             invented: the run says there was no table.
 * ARCHITECTURE:
 *   - THE CONTRACT, in one place: the producing agent's result contains exactly ONE JSON array of
 *     flat objects — one object per row, the same keys in every object, every value a string, a
 *     number, true/false or null. `extractTable` finds and validates it; `dataFormatBrief`
 *     generates the sentence that tells the agent so. Both read the same limits, so the prompt
 *     never promises a shape the check refuses.
 *   - DETECTION is a scan for JSON arrays anywhere in the text (bare, inside a ``` fence, or as a
 *     property of a wrapping object). An array that is not made of objects (`[1, 2]`, a markdown
 *     link) is not a table and is ignored. Two tables are refused rather than one being picked.
 *   - NOTHING IS REPAIRED. A row with a missing key, a nested value or a duplicate column is a
 *     refusal with the row and the reason — the alternative is a dataset whose columns nobody
 *     chose.
 *   - Pure: no `server-only`. The engine, the builder's notes and the tests share it.
 */

/** Row and size limits of a table saved from a result (the in-band ingest limit is 2 MB). */
export const TABLE_MAX_ROWS = 5_000;
export const TABLE_MAX_COLUMNS = 100;
export const TABLE_MAX_CSV_BYTES = 1_500_000;
const COLUMN_NAME_MAX = 64;

export type TableCell = string | number | boolean | null;

export type ExtractedTable =
  | { ok: true; columns: string[]; rows: Record<string, TableCell>[]; csv: string }
  | { ok: false; reason: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The end index (exclusive) of the JSON array that starts at `text[start] === '['`, or -1 when
 * the brackets do not balance. String-aware, so a `]` inside a quoted value does not end it.
 */
function arrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return c === ']' ? i + 1 : -1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Every top-level JSON array of objects in the text, plus how many empty arrays were seen. */
function candidateArrays(text: string): { tables: Record<string, unknown>[][]; empty: number } {
  const tables: Record<string, unknown>[][] = [];
  let empty = 0;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('[', i);
    if (start < 0) break;
    const end = arrayEnd(text, start);
    if (end < 0) {
      i = start + 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end));
    } catch {
      i = start + 1;
      continue;
    }
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) empty += 1;
      // A table is an array whose FIRST element is an object; whether every row is one is
      // validated later, with the row number, instead of the array silently not counting.
      else if (isPlainObject(parsed[0])) tables.push(parsed as Record<string, unknown>[]);
    }
    i = end; // never look inside an array that was read (a nested array is not a second table)
  }
  return { tables, empty };
}

function csvCell(v: TableCell): string {
  if (v === null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a header row, in the first row's column order. */
export function tableToCsv(columns: string[], rows: Record<string, TableCell>[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c] ?? null)).join(','));
  return `${lines.join('\n')}\n`;
}

/**
 * Find and validate the ONE table in an agent's result. Returns the rows and their CSV, or the
 * precise reason there is none — never a best guess.
 */
export function extractTable(text: string): ExtractedTable {
  const { tables, empty } = candidateArrays(text ?? '');
  if (tables.length === 0) {
    return {
      ok: false,
      reason: empty > 0 ? 'the JSON list in the result is empty' : 'no table in the result',
    };
  }
  if (tables.length > 1) {
    return { ok: false, reason: `the result contains ${tables.length} JSON lists — exactly one is expected, so none was chosen` };
  }
  const raw = tables[0];
  if (raw.length > TABLE_MAX_ROWS) {
    return { ok: false, reason: `the table has ${raw.length} rows — at most ${TABLE_MAX_ROWS} can be saved from a result` };
  }
  const columns = Object.keys(raw[0]);
  if (columns.length === 0) return { ok: false, reason: 'the first row has no columns' };
  if (columns.length > TABLE_MAX_COLUMNS) {
    return { ok: false, reason: `the table has ${columns.length} columns — at most ${TABLE_MAX_COLUMNS} can be saved from a result` };
  }
  const seen = new Set<string>();
  for (const c of columns) {
    const name = c.trim();
    // eslint-disable-next-line no-control-regex
    if (!name || name.length > COLUMN_NAME_MAX || /[\u0000-\u001f]/.test(c)) {
      return { ok: false, reason: `the column name ${JSON.stringify(c)} is empty, longer than ${COLUMN_NAME_MAX} characters or contains a line break` };
    }
    if (seen.has(name.toLowerCase())) return { ok: false, reason: `the column ${JSON.stringify(name)} appears twice` };
    seen.add(name.toLowerCase());
  }
  const rows: Record<string, TableCell>[] = [];
  for (let r = 0; r < raw.length; r += 1) {
    const row = raw[r];
    const n = r + 1;
    if (!isPlainObject(row)) return { ok: false, reason: `row ${n} is not an object` };
    const keys = Object.keys(row);
    const missing = columns.filter((c) => !(c in row));
    const extra = keys.filter((k) => !columns.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      const parts = [
        missing.length > 0 ? `misses ${missing.map((m) => JSON.stringify(m)).join(', ')}` : '',
        extra.length > 0 ? `adds ${extra.map((m) => JSON.stringify(m)).join(', ')}` : '',
      ].filter(Boolean);
      return { ok: false, reason: `row ${n} does not have the same keys as row 1 (it ${parts.join(' and ')}) — use null for a missing value` };
    }
    const out: Record<string, TableCell> = {};
    for (const c of columns) {
      const v = row[c];
      if (v === null || typeof v === 'string' || typeof v === 'boolean') out[c] = v;
      else if (typeof v === 'number' && Number.isFinite(v)) out[c] = v;
      else return { ok: false, reason: `row ${n}, column ${JSON.stringify(c)} is not a plain value (a list or an object cannot be a cell)` };
    }
    rows.push(out);
  }
  const csv = tableToCsv(columns, rows);
  const bytes = new TextEncoder().encode(csv).length;
  if (bytes > TABLE_MAX_CSV_BYTES) {
    return { ok: false, reason: `the table is ${(bytes / 1_048_576).toFixed(1)} MB — at most ${(TABLE_MAX_CSV_BYTES / 1_048_576).toFixed(1)} MB can be saved from a result` };
  }
  return { ok: true, columns, rows, csv };
}

/**
 * The exact format a Data output needs, as the sentence the producing agent is given. Generated
 * here so it always states the rule `extractTable` enforces.
 */
export function dataFormatBrief(outputName: string, inSection = false): string {
  const where = inSection ? 'its section of your final answer' : 'your final answer';
  return [
    `For the dataset "${outputName}", ${where} MUST contain exactly one JSON list:`,
    'one object per row, the SAME keys in every object, and every value a string, a number,',
    'true/false or null (no nested lists or objects; use null where a value is missing).',
    `At most ${TABLE_MAX_ROWS} rows. Example: [{"invoice_no":"R-1001","net_amount":250.0,"paid":true}].`,
    `You may add explanation around it, but no second JSON list${inSection ? ' in that section' : ''}. If there are no rows, say so in`,
    'words and do not write an empty list.',
  ].join(' ');
}

/**
 * Do an agent's instructions ask for the table at all? A deliberately cheap test for the BUILDER
 * (not the run): it only decides whether a note is shown next to a Dataset output. It looks for
 * the vocabulary of a structured result; it does not judge whether the wording is good.
 */
export function instructionsAskForTable(agentMd: string): boolean {
  return /\b(json|csv|table|tabelle|rows?|zeilen?|list of objects|one object per|structured)\b/i.test(agentMd ?? '');
}
