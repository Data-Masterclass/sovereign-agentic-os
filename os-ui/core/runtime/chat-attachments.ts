/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Chat attachments — what a dropped, pasted or attached file IS, where it may go,
 *             and how the turn names what was created
 * USER STORY: As a user I want to drop a CSV, an Excel workbook, a PDF, a deck or a markdown note
 *             into the chat and have it land in the right place (Data, Files or Knowledge) in my
 *             own My scope, with the assistant told exactly what was created so it can use it.
 * ARCHITECTURE:
 *   - PURE and client-safe (no `server-only`, no Buffer, no tab imports): the composer runs the
 *     SAME sniff on the first/last 64 KB of a File to pre-select a destination, and the server
 *     (`chat-attachments-server.ts`) runs it again on the real bytes — the server's answer wins.
 *   - The type is decided by CONTENT first (magic bytes; ZIP part names for OOXML; UTF-8 text
 *     validity), the extension only disambiguates text. A `.csv` that is really a PDF is a PDF
 *     (→ Files); a `.csv` that is binary is refused. Anything not on the allow-list is refused.
 *   - `ROUTES` is the closed allow-list: kind → the destinations it may go to, first = default.
 *     It is an array-derived union, so the server can check a client-supplied value at runtime.
 *   - Nothing here executes or renders file content; text is only classified.
 */

/** Most files one chat message may carry. */
export const ATTACHMENT_MAX_FILES = 5;
/** A markdown note saved as Knowledge (the same cap `save_knowledge_note` applies). */
export const KNOWLEDGE_NOTE_MAX_BYTES = 512 * 1024;
/** How much of the head (and tail) the sniff reads. */
export const SNIFF_WINDOW = 64 * 1024;

export const DESTINATIONS = ['data', 'files', 'knowledge'] as const;
export type Destination = (typeof DESTINATIONS)[number];
export const DESTINATION_LABEL: Record<Destination, string> = { data: 'Data', files: 'Files', knowledge: 'Knowledge' };
export const isDestination = (v: unknown): v is Destination => typeof v === 'string' && (DESTINATIONS as readonly string[]).includes(v);

export const ATTACHMENT_KINDS = ['csv', 'tsv', 'parquet', 'json', 'ndjson', 'xlsx', 'pdf', 'docx', 'pptx', 'md', 'txt'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** The closed routing table: each kind's allowed destinations, the FIRST being the default. */
export const ROUTES: Record<AttachmentKind, readonly Destination[]> = {
  csv: ['data', 'files'],
  tsv: ['data', 'files'],
  parquet: ['data', 'files'],
  json: ['data', 'files'],
  ndjson: ['data', 'files'],
  xlsx: ['data', 'files'],
  pdf: ['files'],
  docx: ['files'],
  pptx: ['files'],
  md: ['knowledge', 'files'],
  txt: ['files', 'knowledge'],
};

/** The extensions a stored name may keep for a kind (else the kind's own is appended). */
const KIND_EXTS: Record<AttachmentKind, readonly string[]> = {
  csv: ['csv'], tsv: ['tsv'], parquet: ['parquet'], json: ['json'], ndjson: ['ndjson', 'jsonl'], xlsx: ['xlsx'],
  pdf: ['pdf'], docx: ['docx'], pptx: ['pptx'], md: ['md', 'markdown'], txt: ['txt', 'text'],
};

/** The `accept` list for the composer's file picker (a hint only; the sniff decides). */
export const ATTACH_ACCEPT = '.csv,.tsv,.txt,.parquet,.json,.ndjson,.jsonl,.xlsx,.pdf,.docx,.pptx,.md,.markdown';

export type Sniff =
  | { ok: true; kind: AttachmentKind; destinations: readonly Destination[]; defaultDestination: Destination }
  | { ok: false; reason: string };

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PAR1 = [0x50, 0x41, 0x52, 0x31];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const LOCAL_SIG = [0x50, 0x4b, 0x03, 0x04];
const CENTRAL_SIG = [0x50, 0x4b, 0x01, 0x02];

/**
 * The part (entry) names a window of a ZIP declares: every local file header (name at +30,
 * length at +26) and every central-directory header (name at +46, length at +28) whose name
 * lies wholly inside the window. Names are matched EXACTLY by the caller, so `foo/xl/workbook.xml`
 * or the text "xl/workbook.xml" inside a part's content never counts as a workbook.
 */
export function zipEntryNames(b: Uint8Array): Set<string> {
  const names = new Set<string>();
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i + 4 <= b.length; i += 1) {
    if (b[i] !== 0x50 || b[i + 1] !== 0x4b) continue;
    let lenAt = -1;
    let nameAt = -1;
    if (startsWith(b, LOCAL_SIG, i)) { lenAt = i + 26; nameAt = i + 30; }
    else if (startsWith(b, CENTRAL_SIG, i)) { lenAt = i + 28; nameAt = i + 46; }
    else continue;
    if (lenAt + 2 > b.length) continue;
    const len = u16(b, lenAt);
    if (len === 0 || len > 1024 || nameAt + len > b.length) continue;
    names.add(dec.decode(b.subarray(nameAt, nameAt + len)));
  }
  return names;
}

/** Drop an incomplete UTF-8 sequence cut off at the end of a window. */
function trimPartialUtf8(b: Uint8Array): Uint8Array {
  let i = b.length;
  let back = 0;
  while (i > 0 && back < 3 && (b[i - 1] & 0xc0) === 0x80) { i -= 1; back += 1; }
  if (i > 0) {
    const lead = b[i - 1];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > 1 && back + 1 < need) return b.subarray(0, i - 1);
  }
  return b;
}

/** Is every byte sequence well-formed UTF-8 (no overlongs, no surrogates, nothing above U+10FFFF)? */
export function isUtf8(b: Uint8Array): boolean {
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c < 0x80) { i += 1; continue; }
    let need: number;
    let min: number;
    if (c >= 0xc2 && c <= 0xdf) { need = 1; min = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { need = 2; min = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { need = 3; min = 0x10000; }
    else return false;
    let cp = c & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    for (let k = 1; k <= need; k += 1) {
      const x = b[i + k];
      if (x === undefined || (x & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (x & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

/** The text of `head` when it is UTF-8 without NUL bytes; null when the content is binary. */
function asText(head: Uint8Array, truncated: boolean): string | null {
  if (head.includes(0)) return null;
  const bytes = truncated ? trimPartialUtf8(head) : head;
  if (!isUtf8(bytes)) return null;
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** A consistent delimiter across the complete lines of the head: ',' or '\t', else null. */
function delimiterOf(text: string, truncated: boolean): ',' | '\t' | null {
  const lines = text.split(/\r?\n/);
  if (truncated) lines.pop(); // the last line may be cut mid-row
  const rows = lines.filter((l) => l.trim() !== '').slice(0, 20);
  if (rows.length < 2) return null;
  for (const d of ['\t', ','] as const) {
    const counts = rows.map((l) => l.replace(/"[^"]*"/g, '').split(d).length - 1);
    if (counts[0] >= 1 && counts.every((c) => c === counts[0])) return d;
  }
  return null;
}

const firstLine = (text: string): string => text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
function parsesAsObject(line: string): boolean {
  try {
    const v = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

const accept = (kind: AttachmentKind): Sniff => ({ ok: true, kind, destinations: ROUTES[kind], defaultDestination: ROUTES[kind][0] });
const refuse = (reason: string): Sniff => ({ ok: false, reason });

/**
 * What a file IS, from its bytes (and its name only to tell text formats apart).
 * `head` = the first bytes (up to SNIFF_WINDOW or the whole file); `tail` = the last bytes when
 * the file is larger than the head (a ZIP lists every part name in its central directory, at the end);
 * `size` = the full size, so the sniff knows whether `head` was cut.
 */
export function sniffAttachment(name: string, head: Uint8Array, opts: { tail?: Uint8Array; size?: number } = {}): Sniff {
  const label = `“${sanitizeFilename(name)}”`;
  const ext = extOf(name);
  const size = opts.size ?? head.length;
  if (size === 0 || head.length === 0) return refuse(`${label} is empty.`);
  const truncated = head.length < size;

  if (startsWith(head, PDF)) return accept('pdf');
  if (startsWith(head, PAR1)) return accept('parquet');
  if (startsWith(head, ZIP)) {
    const names = zipEntryNames(head);
    if (opts.tail) for (const n of zipEntryNames(opts.tail)) names.add(n);
    if (names.has('xl/workbook.xml')) return accept('xlsx');
    if (names.has('word/document.xml')) return accept('docx');
    if (names.has('ppt/presentation.xml')) return accept('pptx');
    return refuse(`${label} is a ZIP archive, which cannot be attached. Attach the files inside it instead.`);
  }
  if (startsWith(head, OLE)) {
    return refuse(`${label} is in an older Office format (.xls, .doc or .ppt). Save it as .xlsx, .docx or .pptx and attach that.`);
  }

  const text = asText(head.subarray(0, SNIFF_WINDOW), truncated || head.length > SNIFF_WINDOW);
  if (text === null) {
    if (!head.includes(0) && ['csv', 'tsv', 'txt', 'text', 'md', 'markdown', 'json', 'ndjson', 'jsonl'].includes(ext)) {
      return refuse(`${label} is not UTF-8 text (it may be saved in an older encoding such as Windows-1252). Save it as UTF-8 (in Excel: “CSV UTF-8”) and attach it again.`);
    }
    return refuse(`${label} is not a supported file type: its content is binary${ext ? ` although it is named .${ext}` : ''}. ` +
      'Attach CSV, TSV, Parquet, JSON, Excel (.xlsx), PDF, Word (.docx), PowerPoint (.pptx), markdown or plain text.');
  }
  const cut = truncated || head.length > SNIFF_WINDOW;
  const trimmed = text.trimStart();

  if (ext === 'md' || ext === 'markdown') return accept('md');
  if (ext === 'json') {
    return /^[{[]/.test(trimmed) ? accept('json') : refuse(`${label} is named .json but its content is not JSON.`);
  }
  if (ext === 'ndjson' || ext === 'jsonl') {
    return parsesAsObject(firstLine(text)) ? accept('ndjson') : refuse(`${label} is named .${ext} but its first line is not a JSON object.`);
  }
  if (ext === 'csv') return delimiterOf(text, cut) === '\t' ? accept('tsv') : accept('csv');
  if (ext === 'tsv') return accept('tsv');
  if (ext === 'txt' || ext === 'text' || ext === '') {
    if (trimmed.startsWith('<')) return refuse(`${label} looks like HTML or XML markup, which cannot be attached.`);
    const d = delimiterOf(text, cut);
    if (d === '\t') return accept('tsv');
    if (d === ',') return accept('csv');
    if (ext === '' && /^[{[]/.test(trimmed)) return parsesAsObject(firstLine(text)) && text.split(/\r?\n/).filter((l) => l.trim()).length > 1 ? accept('ndjson') : accept('json');
    return accept('txt');
  }
  return refuse(`${label} (.${ext}) is not a supported attachment type. ` +
    'Attach CSV, TSV, Parquet, JSON, Excel (.xlsx), PDF, Word (.docx), PowerPoint (.pptx), markdown or plain text.');
}

/** Is the WHOLE file UTF-8 text without NUL bytes? (A note is checked end to end, not only its head.) */
export function isUtf8Text(bytes: Uint8Array): boolean {
  return !bytes.includes(0) && isUtf8(bytes);
}

/** Sniff the whole file: its head and, when larger, its tail. */
export function sniffBytes(name: string, bytes: Uint8Array): Sniff {
  const head = bytes.subarray(0, SNIFF_WINDOW);
  const tail = bytes.length > SNIFF_WINDOW ? bytes.subarray(Math.max(SNIFF_WINDOW, bytes.length - SNIFF_WINDOW)) : undefined;
  return sniffAttachment(name, head, { tail, size: bytes.length });
}

/**
 * A filename safe to store and show: the last path segment only, no control or bidi-override
 * characters (an "invoice‮fdp.exe" spoof), no characters a file system or a header reserves, no
 * leading dots, at most 120 characters with the extension kept.
 */
export function sanitizeFilename(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  let s = base.normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[<>:"|?*`$]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (s.length > 120) {
    const ext = extOf(s);
    const keep = ext && ext.length <= 10 ? `.${ext}` : '';
    s = s.slice(0, 120 - keep.length).trimEnd() + keep;
  }
  return s || 'attachment';
}

/** The name the item is stored under: sanitised, with the sniffed kind's extension when the name lies. */
export function storedName(name: string, kind: AttachmentKind): string {
  const safe = sanitizeFilename(name);
  return KIND_EXTS[kind].includes(extOf(safe)) ? safe : `${safe}.${KIND_EXTS[kind][0]}`;
}

/** The title of a created item: the stored name without its extension. */
export function titleOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'attachment';
}

/** May a file of this kind go to that destination? A client-supplied destination is checked here. */
export function destinationAllowed(kind: AttachmentKind, dest: unknown): dest is Destination {
  return isDestination(dest) && ROUTES[kind].includes(dest);
}

// ------------------------------------------------------------------ results --

export type AttachmentOutcome = 'created' | 'denied' | 'rejected' | 'failed';
export type CreatedItem = {
  type: 'dataset' | 'file' | 'knowledge';
  id: string;
  title: string;
  /** A same-origin path in the OS (never model- or file-supplied). */
  href: string;
  /** One plain sentence about the state it landed in (rows ingested, searchable, …). */
  detail?: string;
};
export type AttachmentResult = {
  name: string;
  kind?: AttachmentKind;
  destination?: Destination;
  outcome: AttachmentOutcome;
  message: string;
  item?: CreatedItem;
};

const ITEM_LABEL: Record<CreatedItem['type'], string> = { dataset: 'Dataset', file: 'File', knowledge: 'Knowledge note' };

/**
 * The block the composer puts in front of the user's text, so the assistant knows, in THIS
 * turn, exactly what was created (ids it can pass to get_dataset / get_file / get_knowledge)
 * and what was not.
 */
export function attachmentReference(results: readonly AttachmentResult[]): string {
  const made = results.filter((r) => r.outcome === 'created' && r.item);
  const notMade = results.filter((r) => r.outcome !== 'created');
  if (results.length === 0) return '';
  const lines: string[] = [];
  if (made.length) {
    lines.push('Attached files — uploaded to my My scope just now:');
    for (const r of made) {
      const i = r.item!;
      lines.push(`- ${ITEM_LABEL[i.type]} "${i.title}" (id ${i.id}, ${DESTINATION_LABEL[r.destination ?? 'files']}${i.detail ? `; ${i.detail}` : ''}) — ${i.href}`);
    }
  }
  if (notMade.length) {
    lines.push(made.length ? 'Not uploaded:' : 'Attached files — none could be uploaded:');
    for (const r of notMade) lines.push(`- "${r.name}": ${r.message}`);
  }
  return lines.join('\n');
}

/** The user's message as sent: the attachment block, then what they typed. */
export function composeWithAttachments(text: string, results: readonly AttachmentResult[]): string {
  const ref = attachmentReference(results);
  const body = text.trim();
  if (!ref) return body;
  return body ? `${ref}\n\n${body}` : ref;
}
