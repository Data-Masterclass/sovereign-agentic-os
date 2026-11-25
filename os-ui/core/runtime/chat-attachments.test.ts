/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Chat attachments — the sniff, the routing table and the attachment door's governance
 * USER STORY: As a user I want a dropped file routed by what it really is (not by its name), my
 *             choice of destination honoured only where it is allowed, and every file checked by
 *             policy and audited — with nothing written when policy says no.
 * ARCHITECTURE:
 *   - The sniff and the reference block are pure (`chat-attachments.ts`).
 *   - The door (`routeAttachments`) runs with the REAL `authorize()` (core/infra/governed.ts → the OPA
 *     adapter); only the network is stubbed: `fetch` plays OPA with a scripted verdict and records
 *     what was asked (`agentic/authz/upload_create`). The sinks are recording fakes here; the real
 *     tab services are exercised in `tests/chat/chat-attachment-sinks.test.ts`. The Rego itself is proven in
 *     `authz_test.rego` and against a real OPA in `tests/opa/upload-create.int.test.ts`.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { xlsx, docx, zip } from '../testing/account-fixtures.ts';
import {
  sniffAttachment, sniffBytes, sanitizeFilename, storedName, destinationAllowed, attachmentReference, composeWithAttachments,
  ATTACHMENT_MAX_FILES, KNOWLEDGE_NOTE_MAX_BYTES, ROUTES, type AttachmentResult,
} from './chat-attachments.ts';
import { routeAttachments, type AttachmentAuditEntry, type AttachmentPorts, type AttachmentUser } from './chat-attachments-server.ts';
import { authorize, uploadCreateDecision } from '../infra/governed.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const kindOf = (name: string, bytes: Uint8Array) => { const s = sniffBytes(name, bytes); return s.ok ? s.kind : `refused: ${s.reason}`; };
const PDF = enc('%PDF-1.7\n1 0 obj << /Type /Catalog >>\nendobj\n');
const PARQUET = new Uint8Array([0x50, 0x41, 0x52, 0x31, 1, 2, 3, 0x50, 0x41, 0x52, 0x31]);
const BINARY = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0xff, 0xfe, 0x00, 0x13]);
const pptx = () => zip({ '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<p:presentation/>' });

// ------------------------------------------------------------------- sniff --

test('routing by sniffed type: data formats → Data, documents → Files, markdown → Knowledge', () => {
  const cases: [string, Uint8Array, string, string][] = [
    ['sales.csv', enc('region,amount\nnorth,10\nsouth,20\n'), 'csv', 'data'],
    ['sales.tsv', enc('region\tamount\nnorth\t10\n'), 'tsv', 'data'],
    ['events.parquet', PARQUET, 'parquet', 'data'],
    ['rows.json', enc('[{"a":1},{"a":2}]'), 'json', 'data'],
    ['rows.ndjson', enc('{"a":1}\n{"a":2}\n'), 'ndjson', 'data'],
    ['budget.xlsx', xlsx({ S: [['a', 'b'], [1, 2]] }), 'xlsx', 'data'],
    ['report.pdf', PDF, 'pdf', 'files'],
    ['memo.docx', docx(['Hello']), 'docx', 'files'],
    ['deck.pptx', pptx(), 'pptx', 'files'],
    ['notes.md', enc('# Our refund rule\n\nRefund within 30 days.'), 'md', 'knowledge'],
    ['readme.txt', enc('Just a plain sentence about nothing in particular.'), 'txt', 'files'],
  ];
  for (const [name, bytes, kind, dest] of cases) {
    const s = sniffBytes(name, bytes);
    assert.ok(s.ok, `${name}: ${!s.ok ? s.reason : ''}`);
    assert.equal(s.kind, kind, name);
    assert.equal(s.defaultDestination, dest, name);
  }
});

test('CONTENT wins over the name: a .csv that is really a PDF is a PDF (→ Files); a binary .csv is refused', () => {
  assert.equal(kindOf('totally-a.csv', PDF), 'pdf');
  const s = sniffBytes('totally-a.csv', BINARY);
  assert.equal(s.ok, false);
  assert.match(!s.ok ? s.reason : '', /binary although it is named \.csv/);
  // and the other way round: a workbook named .pdf is a workbook
  assert.equal(kindOf('quarter.pdf', xlsx({ S: [['a'], [1]] })), 'xlsx');
});

test('content-sniffed text: a .txt with a consistent delimiter is CSV/TSV data; a delimiter-free .txt is a document', () => {
  assert.equal(kindOf('export.txt', enc('a,b,c\n1,2,3\n4,5,6\n')), 'csv');
  assert.equal(kindOf('export.txt', enc('a\tb\n1\t2\n')), 'tsv');
  assert.equal(kindOf('export.txt', enc('Hello, world. This line has a comma.\nThis one has none\n')), 'txt');
  assert.equal(kindOf('tabbed.csv', enc('a\tb\n1\t2\n')), 'tsv');
});

test('refused in plain words: unknown types, archives, legacy Office, markup, a .json that is not JSON, empty files', () => {
  const reason = (name: string, b: Uint8Array) => { const s = sniffBytes(name, b); assert.equal(s.ok, false, name); return !s.ok ? s.reason : ''; };
  assert.match(reason('tool.exe', new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 0, 0])), /not a supported file type/);
  assert.match(reason('script.sh', enc('#!/bin/sh\nrm -rf /\n')), /\(\.sh\) is not a supported attachment type/);
  assert.match(reason('bundle.zip', zip({ 'a.txt': 'x' })), /ZIP archive/);
  assert.match(reason('old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), /older Office format/);
  assert.match(reason('page.txt', enc('<html><script>alert(1)</script></html>')), /HTML or XML/);
  assert.match(reason('data.json', enc('this is not json')), /not JSON/);
  assert.match(reason('empty.csv', new Uint8Array(0)), /is empty/);
});

test('an OOXML part list past the first 64 KB is found in the tail (the ZIP central directory)', () => {
  const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200 * 1024, 0x41), Buffer.from('xl/workbook.xml')]);
  assert.equal(kindOf('big.xlsx', big), 'xlsx');
  const s = sniffAttachment('big.xlsx', big.subarray(0, 64 * 1024), { size: big.length });
  assert.equal(s.ok, false, 'without the tail the workbook cannot be told from a plain ZIP');
});

test('a UTF-8 character cut at the sniff window is not mistaken for binary', () => {
  const text = 'ä'.repeat(40 * 1024) + '\n';
  assert.equal(kindOf('umlauts.txt', enc(text)), 'txt');
});

test('filenames are sanitised: path parts, control and bidi-override characters, reserved characters, length', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Users\\x\\report.pdf'), 'report.pdf');
  assert.equal(sanitizeFilename('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(sanitizeFilename('a\u0000b\nc.csv'), 'abc.csv');
  assert.equal(sanitizeFilename('q<3>|"x".md'), 'q_3___x_.md');
  assert.equal(sanitizeFilename('...hidden.csv'), 'hidden.csv');
  assert.equal(sanitizeFilename(''), 'attachment');
  const long = sanitizeFilename(`${'x'.repeat(300)}.xlsx`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.xlsx'));
  // the stored name carries the SNIFFED type when the name lies
  assert.equal(storedName('totally-a.csv', 'pdf'), 'totally-a.csv.pdf');
  assert.equal(storedName('sales.csv', 'csv'), 'sales.csv');
});

test('destination changes are checked against the closed routing table', () => {
  assert.equal(destinationAllowed('csv', 'files'), true);
  assert.equal(destinationAllowed('md', 'files'), true);
  assert.equal(destinationAllowed('pdf', 'data'), false);
  assert.equal(destinationAllowed('pdf', 'knowledge'), false);
  assert.equal(destinationAllowed('csv', 'knowledge'), false);
  assert.equal(destinationAllowed('csv', 'promote-to-company'), false);
  for (const [kind, dests] of Object.entries(ROUTES)) assert.ok(dests.length >= 1, kind);
});

test('the reference block names every created item by id and every refusal, ahead of what the user typed', () => {
  const results: AttachmentResult[] = [
    { name: 'sales.csv', kind: 'csv', destination: 'data', outcome: 'created', message: '', item: { type: 'dataset', id: 'ds_1', title: 'sales', href: '/data?focus=ds_1', detail: 'Bronze landed: 2 rows' } },
    { name: 'deck.pptx', kind: 'pptx', destination: 'files', outcome: 'created', message: '', item: { type: 'file', id: 'as_9', title: 'deck.pptx', href: '/unstructured?focus=as_9' } },
    { name: 'x.exe', outcome: 'rejected', message: 'not a supported file type' },
  ];
  const text = composeWithAttachments('What is the total by region?', results);
  assert.match(text, /^Attached files — uploaded to my My scope just now:/);
  assert.match(text, /Dataset "sales" \(id ds_1, Data; Bronze landed: 2 rows\) — \/data\?focus=ds_1/);
  assert.match(text, /File "deck\.pptx" \(id as_9, Files\)/);
  assert.match(text, /Not uploaded:\n- "x\.exe": not a supported file type/);
  assert.ok(text.endsWith('\n\nWhat is the total by region?'));
  assert.equal(attachmentReference([]), '');
  assert.equal(composeWithAttachments(' hi ', []), 'hi');
});

// -------------------------------------------------------------------- door --

const cara: AttachmentUser = { id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' };
type Write = { dest: string; name: string; title: string; kind: string; bytes: number };
let writes: Write[] = [];
let audits: AttachmentAuditEntry[] = [];
let asks: Record<string, unknown>[] = [];
let verdict: (input: Record<string, unknown>) => boolean | 'unreachable' = () => true;
const realFetch = globalThis.fetch;

const sink = (dest: 'data' | 'files' | 'knowledge', max: number) => ({
  maxBytes: () => max,
  create: async (_u: AttachmentUser, i: { name: string; title: string; kind: string; bytes: Buffer }) => {
    writes.push({ dest, name: i.name, title: i.title, kind: i.kind, bytes: i.bytes.length });
    if (i.title === 'explodes') throw new Error('the data-runner said no');
    const type = dest === 'data' ? 'dataset' as const : dest === 'files' ? 'file' as const : 'knowledge' as const;
    return { type, id: `${dest}_${writes.length}`, title: i.title, href: `/x?focus=${dest}_${writes.length}` };
  },
});
const ports = (): AttachmentPorts => ({
  sinks: { data: sink('data', 100 * 1024 * 1024), files: sink('files', 200 * 1024 * 1024), knowledge: sink('knowledge', KNOWLEDGE_NOTE_MAX_BYTES) },
  // the REAL authorize: what the route passes
  authorizeCreate: (u, d) => authorize(`user:${u.id}`, 'upload.create', uploadCreateDecision(u, d === 'data' ? 'dataset' : d === 'files' ? 'file' : 'knowledge')),
  audit: (e) => { audits.push(e); },
});
const file = (name: string, body: string | Uint8Array, destination?: unknown) => ({ name, bytes: Buffer.from(typeof body === 'string' ? enc(body) : body), destination });

beforeEach(() => {
  writes = []; audits = []; asks = []; verdict = () => true;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (!u.includes('/v1/data/agentic/authz/')) return realFetch(url as string, init as RequestInit);
    assert.match(u, /\/v1\/data\/agentic\/authz\/upload_create$/);
    const input = (JSON.parse(init?.body ?? '{}') as { input: Record<string, unknown> }).input;
    asks.push(input);
    const v = verdict(input);
    if (v === 'unreachable') throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ result: v, decision_id: 'dec-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test('door: each file goes to its sniffed destination after an OPA create decision on the caller’s My scope; each is audited', async () => {
  const out = await routeAttachments(cara, [
    file('sales.csv', 'region,amount\nnorth,10\n'),
    file('report.pdf', PDF),
    file('refunds.md', '# Refunds\n30 days.'),
    file('book.xlsx', xlsx({ S: [['a'], [1]] })),
  ], ports());
  assert.deepEqual(out.results.map((r) => [r.outcome, r.destination, r.kind]), [
    ['created', 'data', 'csv'], ['created', 'files', 'pdf'], ['created', 'knowledge', 'md'], ['created', 'data', 'xlsx'],
  ]);
  assert.deepEqual(writes.map((w) => [w.dest, w.name, w.title]), [
    ['data', 'sales.csv', 'sales'], ['files', 'report.pdf', 'report'], ['knowledge', 'refunds.md', 'refunds'], ['data', 'book.xlsx', 'book'],
  ]);
  // My scope only: every decision asked is a private create by the caller, as the caller
  assert.equal(asks.length, 4);
  for (const a of asks) {
    assert.equal(a.action, 'upload.create');
    assert.equal(a.principal, 'user:cara');
    assert.deepEqual(a.actor, { id: 'cara', role: 'creator', domains: ['sales'] });
    assert.deepEqual(a.target, { tier: 'personal', owner: 'cara', domain: 'sales' });
  }
  assert.deepEqual(asks.map((a) => a.kind), ['dataset', 'file', 'knowledge', 'dataset']);
  // audit on success: who, what, destination, outcome
  assert.equal(audits.length, 4);
  for (const a of audits) {
    assert.equal(a.actor, 'cara');
    assert.equal(a.action, 'assistant.attachment.create');
    assert.equal(a.result, 'ok');
    assert.equal(a.data.outcome, 'created');
    assert.equal(a.data.scope, 'my');
  }
  assert.equal(audits[0].target, 'data:data_1');
  assert.match(out.reference, /id data_1/);
  assert.equal(out.refusedAll, false);
});

test('door: OPA deny → nothing written, the file is reported denied and audited as denied', async () => {
  verdict = (i) => i.kind !== 'file';
  const out = await routeAttachments(cara, [file('report.pdf', PDF), file('sales.csv', 'a,b\n1,2\n')], ports());
  assert.equal(out.results[0].outcome, 'denied');
  assert.match(out.results[0].message, /Policy did not allow creating a file in your My scope.*Nothing was written/);
  assert.deepEqual(writes.map((w) => w.dest), ['data'], 'only the allowed file was written');
  assert.equal(audits[0].result, 'denied');
  assert.equal(audits[0].data.outcome, 'denied');
  assert.equal(audits[0].data.destination, 'files');
  assert.equal(audits[1].result, 'ok');
});

test('door: an OPA that does not answer denies (never fails open) and writes nothing', async () => {
  verdict = () => 'unreachable';
  const out = await routeAttachments(cara, [file('sales.csv', 'a,b\n1,2\n')], ports());
  assert.equal(out.results[0].outcome, 'denied');
  assert.equal(writes.length, 0);
  assert.equal(audits[0].result, 'denied');
});

test('door: a 6th file refuses the whole message before anything is decided or written; each file is audited', async () => {
  const six = Array.from({ length: ATTACHMENT_MAX_FILES + 1 }, (_, i) => file(`f${i}.csv`, 'a,b\n1,2\n'));
  const out = await routeAttachments(cara, six, ports());
  assert.equal(out.refusedAll, true);
  assert.equal(out.results.length, 6);
  for (const r of out.results) {
    assert.equal(r.outcome, 'rejected');
    assert.match(r.message, /at most 5 files \(this one had 6\)\. Nothing was uploaded/);
  }
  assert.equal(asks.length, 0, 'no policy decision was even asked');
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 6);
  assert.ok(audits.every((a) => a.result === 'denied'));
});

test('door: oversize — a file over its destination’s cap, and a message over the total cap, are refused unwritten', async () => {
  const bigNote = '#'.repeat(KNOWLEDGE_NOTE_MAX_BYTES + 1);
  const out = await routeAttachments(cara, [file('huge.md', bigNote), file('ok.csv', 'a,b\n1,2\n')], ports());
  assert.equal(out.results[0].outcome, 'rejected');
  assert.match(out.results[0].message, /larger than the 512 KB Knowledge accepts/);
  assert.equal(out.results[1].outcome, 'created');
  assert.deepEqual(writes.map((w) => w.name), ['ok.csv']);
  // the same note may go to Files instead, whose cap is larger
  writes = [];
  const moved = await routeAttachments(cara, [file('huge.md', bigNote, 'files')], ports());
  assert.equal(moved.results[0].outcome, 'created');
  assert.equal(writes[0].dest, 'files');
  // whole-message cap
  writes = []; audits = [];
  const total = await routeAttachments(cara, [file('a.csv', 'a,b\n1,2\n'), file('b.csv', 'a,b\n1,2\n')], ports(), { totalMaxBytes: 10 });
  assert.equal(total.refusedAll, true);
  assert.match(total.results[0].message, /exceed/);
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 2);
});

test('door: the user’s destination change is honoured where allowed and refused where not; garbage is refused', async () => {
  const out = await routeAttachments(cara, [
    file('sales.csv', 'a,b\n1,2\n', 'files'),
    file('report.pdf', PDF, 'knowledge'),
    file('notes.md', '# n', 'company'),
  ], ports());
  assert.deepEqual(out.results.map((r) => r.outcome), ['created', 'rejected', 'rejected']);
  assert.equal(out.results[0].destination, 'files');
  assert.match(out.results[1].message, /cannot go to knowledge; choose Files/);
  assert.deepEqual(writes.map((w) => w.dest), ['files']);
});

test('door: a binary file named .csv is refused (or, when it is really a PDF, filed as a PDF under a truthful name)', async () => {
  const out = await routeAttachments(cara, [file('rows.csv', BINARY), file('rows2.csv', PDF)], ports());
  assert.equal(out.results[0].outcome, 'rejected');
  assert.equal(out.results[1].outcome, 'created');
  assert.equal(out.results[1].destination, 'files');
  assert.deepEqual(writes.map((w) => [w.dest, w.name, w.kind]), [['files', 'rows2.csv.pdf', 'pdf']]);
});

test('door: a sink failure is reported and audited as an error, and the other files still land', async () => {
  const out = await routeAttachments(cara, [file('explodes.csv', 'a,b\n1,2\n'), file('fine.md', '# ok')], ports());
  assert.equal(out.results[0].outcome, 'failed');
  assert.match(out.results[0].message, /the data-runner said no/);
  assert.equal(audits[0].result, 'error');
  assert.equal(out.results[1].outcome, 'created');
  assert.match(out.reference, /Not uploaded:\n- "explodes\.csv": the data-runner said no/);
});

test('door: filenames are sanitised before they reach a sink or the audit trail', async () => {
  await routeAttachments(cara, [file('../../secret/..\u202Egnp.md', '# hi')], ports());
  assert.equal(writes[0].name, 'gnp.md');
  assert.equal(audits[0].data.name, 'gnp.md');
});
