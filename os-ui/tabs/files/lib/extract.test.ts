/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A PDF upload gets its text read, stored with the file and indexed — or an honest reason
 * USER STORY: As the owner of invoices an agent rejected as "no readable content" I need the text
 *             the parser reads to be what `get_file` returns; I need a parser outage to leave my
 *             file stored and marked with the specific reason, with nothing invented on ANY
 *             setting; and I need a restricted or opted-out file never to reach the parser.
 * ARCHITECTURE:
 *   - The store, the in-memory object store and the REAL index pipeline are under test; only the
 *     parser (`convert`) and the embedder are injected, at the seams those modules expose.
 *   - "Nothing indexed" is asserted on the index itself (`indexSize()`), not on a status label.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFileText,
  extractionInFlight,
  settleStaleExtraction,
  __resetExtractFlights,
  type ExtractDeps,
} from '@tabs/files/lib/extract';
import type { DoclingDocument, DoclingOutcome } from '@tabs/files/lib/ingest/docling-client';
import {
  attachObject,
  createFile,
  extractionEligibility,
  extractionSubject,
  getFile,
  listFiles,
  objectKeyForAsset,
  searchFiles,
  setIndexingMode,
  setSensitivity,
  __putRecordForTests,
  __resetStore,
  type Principal,
} from '@tabs/files/lib/store';
import { getBlob, putBlob, __resetBlobs } from '@tabs/files/lib/object-store';
import { indexAsset } from '@tabs/files/lib/index-pipeline';
import { __resetIndex, indexSize } from '@tabs/files/lib/index-store';
import { mockEmbed } from '@tabs/files/lib/embed';
import { liveAdapterFor } from '@tabs/files/lib/ingest/live';
import { emptyAsset, serializeAsset, parseAsset, type FileAsset, type Sensitivity } from '@tabs/files/lib/asset-schema';
import { OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const PDF_BYTES = Buffer.from('%PDF-1.4 the original bytes');
const INVOICE_TEXT = 'Invoice INV-2026-0042. Supplier: Example Test GmbH. Total due: 1,234.56 EUR.';

const embed = async (texts: string[]) => ({ vectors: texts.map((t) => mockEmbed(t)), model: 'sovereign-embed', dim: 384, mode: 'mock' as const });

/** The upload door, minus HTTP: record → bytes in the object store → object attached. */
async function upload(name: string, over: { sensitivity?: Sensitivity; text?: string; contentType?: string } = {}): Promise<FileAsset> {
  const asset = createFile(amir, { name, sensitivity: over.sensitivity, text: over.text ?? '', bytes: PDF_BYTES.length });
  const key = objectKeyForAsset(asset)!;
  await putBlob(key, PDF_BYTES, over.contentType ?? 'application/pdf');
  attachObject(asset.id, amir, { contentType: over.contentType ?? 'application/pdf', bytes: PDF_BYTES.length });
  return asset;
}

/** Deps with a scripted parser and the REAL pipeline (the live stored-text adapter, mock embedder). */
function deps(convert: (doc: DoclingDocument) => Promise<DoclingOutcome>): ExtractDeps & { sent: DoclingDocument[] } {
  const sent: DoclingDocument[] = [];
  return {
    sent,
    convert: async (doc) => { sent.push(doc); return convert(doc); },
    getBlob,
    index: async (asset, text) => { await indexAsset(asset, text, { adapter: liveAdapterFor(asset.kind), embed, live: false }); },
  };
}
const ok = async (): Promise<DoclingOutcome> => ({ ok: true, text: INVOICE_TEXT, seconds: 1.2 });
const down = async (): Promise<DoclingOutcome> => ({ ok: false, code: 'parser-unreachable', reason: 'The document parser (Docling) at http://docling:5001 could not be reached (connect ECONNREFUSED).', seconds: 0 });

beforeEach(() => {
  __resetStore();
  __resetBlobs();
  __resetIndex();
  __resetExtractFlights();
});

// ---------------------------------------------------------------------------
//  The fix
// ---------------------------------------------------------------------------

test('a PDF upload starts stored-only for the honest reason `no-text` — not as anyone’s choice', async () => {
  const a = await upload('invoice.pdf');
  assert.equal(a.indexing.mode, 'stored-only');
  assert.equal(a.indexing.storedOnlyReason, 'no-text');
  assert.equal(extractionSubject(a.id)!.eligibility.eligible, true);
});

test('PDF upload → the BYTES go to the parser, the text is STORED on the file, indexed, and get_file returns it', async () => {
  const a = await upload('invoice.pdf');
  const d = deps(ok);
  const out = await extractFileText(a.id, d, { actingUserId: 'amir' });
  assert.equal(out.state, 'extracted');

  // The parser got the original bytes, by name — not a link.
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].name, 'invoice.pdf');
  assert.deepEqual(Buffer.from(d.sent[0].bytes), PDF_BYTES);
  assert.equal(d.sent[0].contentType, 'application/pdf');

  // What `get_file` reads (store.getFile is the body of that MCP tool).
  const view = getFile(a.id, amir);
  assert.equal(view.text, INVOICE_TEXT);
  assert.equal(view.asset.indexing.mode, 'indexed');
  assert.equal(view.asset.indexing.storedOnlyReason, undefined);
  assert.equal(view.asset.indexing.extraction?.status, 'extracted');
  assert.equal(view.asset.indexing.extraction?.chars, INVOICE_TEXT.length);
  assert.notEqual(view.history[0].hash, '00000000', 'the version fingerprint is the real text’s, not the empty string’s');
  assert.equal(view.asset.version, 'v1', 'the bytes did not change, so the content version does not');

  // Searchable: the vector index holds its chunks and the lexical search finds it.
  assert.ok(indexSize() >= 3, 'chunks were indexed');
  assert.equal(listFiles(amir).mine[0].status, 'searchable');
  assert.equal(searchFiles(amir, 'supplier invoice')[0]?.id, a.id);

  // The original object is untouched.
  assert.deepEqual((await getBlob(objectKeyForAsset(a)!))!.body, PDF_BYTES);
});

test('the same holds for the other binary documents the parser reads (DOCX, PPTX, XLSX)', async () => {
  for (const name of ['plan.docx', 'deck.pptx', 'budget.xlsx']) {
    const a = await upload(name, { contentType: 'application/octet-stream' });
    const out = await extractFileText(a.id, deps(ok));
    assert.equal(out.state, 'extracted', name);
    assert.equal(getFile(a.id, amir).text, INVOICE_TEXT, name);
  }
});

// ---------------------------------------------------------------------------
//  Honest failure
// ---------------------------------------------------------------------------

async function withEnv(nodeEnv: string, flag: string | undefined, body: () => Promise<void>): Promise<void> {
  const prevNode = process.env.NODE_ENV;
  const prevFlag = process.env[OFFLINE_MOCK_ENV];
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env[OFFLINE_MOCK_ENV];
  else process.env[OFFLINE_MOCK_ENV] = flag;
  try {
    await body();
  } finally {
    if (prevNode === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNode;
    if (prevFlag === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prevFlag;
  }
}

test('PARSER DOWN: the file is stored, NOT searchable, carries the specific reason, and nothing is indexed — on EVERY offline-mock setting', async () => {
  const settings: [string, string | undefined][] = [
    ['production', undefined],   // the deployed default: refuse
    ['production', 'refuse'],
    ['development', undefined],  // a laptop, where a stand-in WOULD otherwise be allowed
    ['development', 'allow'],
    ['production', 'allow'],
  ];
  for (const [nodeEnv, flag] of settings) {
    await withEnv(nodeEnv, flag, async () => {
      __resetStore(); __resetBlobs(); __resetIndex();
      const a = await upload('invoice.pdf');
      const out = await extractFileText(a.id, deps(down));
      const label = `${nodeEnv}/${flag ?? 'unset'}`;
      assert.equal(out.state, 'failed', label);

      const view = getFile(a.id, amir);
      assert.equal(view.text, '', `${label}: no text was invented`);
      assert.equal(view.asset.indexing.mode, 'stored-only', label);
      assert.equal(view.asset.indexing.storedOnlyReason, 'no-text', label);
      assert.equal(view.asset.indexing.extraction?.status, 'failed', label);
      assert.equal(view.asset.indexing.extraction?.code, 'parser-unreachable', label);
      assert.match(view.asset.indexing.extraction?.reason ?? '', /Docling.*could not be reached/, label);
      assert.equal(indexSize(), 0, `${label}: nothing was indexed`);
      assert.equal(listFiles(amir).mine[0].status, 'stored', label);
      assert.deepEqual(searchFiles(amir, 'invoice supplier'), [], label);
      assert.deepEqual((await getBlob(objectKeyForAsset(a)!))!.body, PDF_BYTES, `${label}: the upload itself is intact`);
    });
  }
});

test('a scan OCR reads nothing from, a timeout and a corrupt file each keep their OWN reason', async () => {
  const cases: DoclingOutcome[] = [
    { ok: false, code: 'no-text', reason: 'The document parser (Docling) read the document and found no text in it.', seconds: 3 },
    { ok: false, code: 'parser-timeout', reason: 'The document parser (Docling) did not finish within 600 s.', seconds: 600 },
    { ok: false, code: 'parser-error', reason: 'The document parser (Docling) could not read this document (failure).', seconds: 0 },
  ];
  for (const c of cases) {
    const a = await upload(`f-${c.ok ? '' : c.code}.pdf`);
    await extractFileText(a.id, deps(async () => c));
    const ex = getFile(a.id, amir).asset.indexing.extraction!;
    assert.equal(ex.status, 'failed');
    assert.equal(ex.code, c.ok ? undefined : c.code);
    assert.equal(ex.reason, c.ok ? undefined : c.reason);
  }
  assert.equal(indexSize(), 0);
});

test('a parser that answers with whitespace stores nothing (a blank is not text)', async () => {
  const a = await upload('blank.pdf');
  const out = await extractFileText(a.id, deps(async () => ({ ok: true, text: '  \n ', seconds: 1 })));
  assert.equal(out.state === 'failed' && out.code, 'no-text');
  assert.equal(getFile(a.id, amir).text, '');
  assert.equal(getFile(a.id, amir).asset.indexing.mode, 'stored-only');
  assert.equal(indexSize(), 0);
});

test('bytes missing from the object store ⇒ a typed failure, and the parser is not called', async () => {
  const a = await upload('gone.pdf');
  const d = { ...deps(ok), getBlob: async () => null };
  const out = await extractFileText(a.id, d);
  assert.equal(out.state === 'failed' && out.code, 'bytes-missing');
  assert.equal(d.sent.length, 0);
});

test('a failed extraction can be retried, and a retry that succeeds makes the file searchable', async () => {
  const a = await upload('invoice.pdf');
  await extractFileText(a.id, deps(down));
  assert.equal(extractionSubject(a.id)!.eligibility.eligible, true, 'a failure is recoverable');
  const out = await extractFileText(a.id, deps(ok));
  assert.equal(out.state, 'extracted');
  assert.equal(getFile(a.id, amir).asset.indexing.mode, 'indexed');
  assert.equal(getFile(a.id, amir).asset.indexing.extraction?.code, undefined, 'the old failure is gone');
});

// ---------------------------------------------------------------------------
//  Decisions are never revisited
// ---------------------------------------------------------------------------

test('RESTRICTED: never sent to the parser, never indexed', async () => {
  const a = await upload('payroll.pdf', { sensitivity: 'restricted' });
  assert.equal(a.indexing.storedOnlyReason, 'restricted');
  const d = deps(ok);
  const out = await extractFileText(a.id, d);
  assert.equal(out.state, 'skipped');
  assert.equal(d.sent.length, 0, 'the bytes never left the store');
  assert.equal(getFile(a.id, amir).text, '');
  assert.equal(indexSize(), 0);
});

test('OWNER OPT-OUT: a user-chosen stored-only file is never sent to the parser', async () => {
  const a = await upload('private-notes.pdf');
  setIndexingMode(a.id, amir, 'stored-only');
  assert.equal(getFile(a.id, amir).asset.indexing.storedOnlyReason, 'opt-out');
  const d = deps(ok);
  assert.equal((await extractFileText(a.id, d)).state, 'skipped');
  assert.equal(d.sent.length, 0);

  // …until the owner asks for it to be indexed again, which is their decision to make.
  setIndexingMode(a.id, amir, 'indexed');
  assert.equal((await extractFileText(a.id, d)).state, 'extracted');
});

test('a file that already has text, a text file and a non-document are not sent to the parser', async () => {
  const withText = await upload('report.pdf', { text: 'A summary someone supplied.' });
  const image = await upload('photo.png', { contentType: 'image/png' });
  const legacyDoc = await upload('old.doc', { contentType: 'application/msword' });
  const d = deps(ok);
  for (const a of [withText, image, legacyDoc]) assert.equal((await extractFileText(a.id, d)).state, 'skipped', a.name);
  assert.equal(d.sent.length, 0);
  assert.equal((await extractFileText('as_missing', d)).state, 'skipped');
});

test('RACE: text that arrives after the owner restricted the file is DISCARDED, not stored', async () => {
  const a = await upload('invoice.pdf');
  let release!: (o: DoclingOutcome) => void;
  const d = deps(() => new Promise<DoclingOutcome>((r) => { release = r; }));
  const flight = extractFileText(a.id, d);
  await new Promise((r) => setImmediate(r));
  setSensitivity(a.id, amir, 'restricted');
  release({ ok: true, text: INVOICE_TEXT, seconds: 5 });
  assert.equal((await flight).state, 'skipped');
  assert.equal(getFile(a.id, amir).text, '');
  assert.equal(indexSize(), 0);
  const after = getFile(a.id, amir).asset;
  assert.equal(after.indexing.storedOnlyReason, 'restricted');
  assert.equal(after.indexing.extraction, undefined, 'no “Extracting…” left hanging on a restricted file');
  assert.equal(listFiles(amir).mine[0].status, 'stored');
});

// ---------------------------------------------------------------------------
//  Not blocking the upload
// ---------------------------------------------------------------------------

test('a slow conversion answers `pending` after the wait, shows “processing”, then finishes in the background', async () => {
  const a = await upload('long-scan.pdf');
  let release!: (o: DoclingOutcome) => void;
  const d = deps(() => new Promise<DoclingOutcome>((r) => { release = r; }));

  const first = await extractFileText(a.id, d, { waitMs: 10 });
  assert.equal(first.state, 'pending');
  assert.equal(getFile(a.id, amir).asset.indexing.extraction?.status, 'pending');
  assert.equal(listFiles(amir).mine[0].status, 'processing');
  assert.equal(extractionInFlight(a.id), true);

  // A second request for the same file joins the flight — the document is not parsed twice.
  const second = extractFileText(a.id, d);
  release({ ok: true, text: INVOICE_TEXT, seconds: 90 });
  assert.equal((await second).state, 'extracted');
  assert.equal(d.sent.length, 1);
  assert.equal(getFile(a.id, amir).text, INVOICE_TEXT);
  assert.equal(listFiles(amir).mine[0].status, 'searchable');
  assert.equal(extractionInFlight(a.id), false);
});

test('a `pending` nobody is running any more (process replaced) becomes an honest, retryable `interrupted`', async () => {
  const a = await upload('orphan.pdf');
  const d = deps(() => new Promise<DoclingOutcome>(() => undefined)); // never answers
  await extractFileText(a.id, d, { waitMs: 5 });
  __resetExtractFlights(); // the process that was running it is gone

  assert.equal(settleStaleExtraction(a.id, 60_000), false, 'not stale yet — leave it alone');
  assert.equal(settleStaleExtraction(a.id, 60_000, Date.now() + 120_000), true);
  const ex = getFile(a.id, amir).asset.indexing.extraction!;
  assert.equal(ex.status, 'failed');
  assert.equal(ex.code, 'interrupted');
  assert.equal(extractionSubject(a.id)!.eligibility.eligible, true);
});

// ---------------------------------------------------------------------------
//  Records written before the reason existed
// ---------------------------------------------------------------------------

/** A record exactly as the pre-fix code wrote it: stored-only, no reason, no extraction. */
function legacy(id: string, name: string, over: { sensitivity?: Sensitivity; text?: string; object?: boolean } = {}): FileAsset {
  const a = emptyAsset({ id, name, owner: 'amir', domain: 'sales', sensitivity: over.sensitivity });
  a.deepLink = `s3://files/amir/${name}`;
  a.indexing.mode = 'stored-only';
  const yaml = serializeAsset(a);
  assert.doesNotMatch(yaml, /storedOnlyReason|extraction/, 'a legacy record carries neither field');
  __putRecordForTests({
    id, owner: 'amir', domain: 'sales', yaml, text: over.text ?? '', bytes: 100,
    object: over.object === false ? null : { key: `amir/${name}`, contentType: 'application/pdf', bytes: 100 },
    history: [{ version: 'v1', hash: '00000000', at: a.provenance.addedAt, bytes: 100 }],
    updatedAt: a.provenance.addedAt,
  });
  return parseAsset(yaml);
}

test('LEGACY HEURISTIC: document + stored bytes + empty text + not restricted ⇒ recoverable; everything else is left alone', () => {
  const rec = (a: FileAsset) => extractionSubject(a.id)!;
  assert.equal(rec(legacy('as_old1', 'old-invoice.pdf')).eligibility.eligible, true);
  assert.equal(rec(legacy('as_old2', 'old-secret.pdf', { sensitivity: 'restricted' })).eligibility.eligible, false);
  assert.equal(rec(legacy('as_old3', 'old-with-text.pdf', { text: 'has text ⇒ stored-only was a choice' })).eligibility.eligible, false);
  assert.equal(rec(legacy('as_old4', 'old-no-bytes.pdf', { object: false })).eligibility.eligible, false);
  assert.equal(rec(legacy('as_old5', 'old-photo.png')).eligibility.eligible, false);
  // The pure predicate, on a hand-built asset, agrees.
  const a = legacy('as_old6', 'x.pdf');
  assert.deepEqual(extractionEligibility(a, { text: '', object: { key: 'k', contentType: 'application/pdf', bytes: 1 } }), { eligible: true });
});

test('LEGACY: an old empty-text PDF is recovered from its stored bytes', async () => {
  const a = legacy('as_old1', 'old-invoice.pdf');
  await putBlob('amir/old-invoice.pdf', PDF_BYTES, 'application/pdf');
  const out = await extractFileText(a.id, deps(ok));
  assert.equal(out.state, 'extracted');
  const view = getFile(a.id, amir);
  assert.equal(view.text, INVOICE_TEXT);
  assert.equal(view.asset.indexing.mode, 'indexed');
  assert.ok(indexSize() > 0);
});

test('the reason and the extraction state survive a YAML round-trip; `restricted` always wins', () => {
  const a = emptyAsset({ id: 'as_rt', name: 'x.pdf', owner: 'amir', domain: 'sales' });
  a.indexing.mode = 'stored-only';
  a.indexing.storedOnlyReason = 'no-text';
  a.indexing.extraction = { status: 'failed', engine: 'docling', at: '2026-11-19T10:00:00.000Z', code: 'parser-timeout', reason: 'took too long' };
  const back = parseAsset(serializeAsset(a));
  assert.equal(back.indexing.storedOnlyReason, 'no-text');
  assert.deepEqual(back.indexing.extraction, a.indexing.extraction);

  a.sensitivity = 'restricted';
  assert.equal(parseAsset(serializeAsset(a)).indexing.storedOnlyReason, 'restricted');
  a.sensitivity = 'internal';
  a.indexing.mode = 'indexed';
  assert.equal(parseAsset(serializeAsset(a)).indexing.storedOnlyReason, undefined, 'an indexed file has no stored-only reason');
});

// ---------------------------------------------------------------------------
//  The doors really call it (an injected test proves the logic, not the wiring)
// ---------------------------------------------------------------------------

test('WIRING: both UI upload branches and the MCP upload go through `ingestUploaded`; the live deps are the real Docling + object store', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const route = readFileSync(`${root}app/api/files/route.ts`, 'utf8');
  assert.equal(route.match(/await ingestUploaded\(asset, text, user\.id\)/g)?.length, 2, 'multipart AND ?upload=raw');
  const mcp = readFileSync(`${root}tabs/files/mcp/file-write-tools.ts`, 'utf8');
  assert.match(mcp, /await ingestUploaded\(documented, textArg \?\? '', user\.id\)/);
  const server = readFileSync(`${root}tabs/files/lib/pipeline-server.ts`, 'utf8');
  assert.match(server, /convert: \(doc\) => convertWithDocling\(doc, \{ baseUrl: config\.doclingUrl, timeoutMs: config\.doclingTimeoutMs \}\)/);
  assert.match(server, /waitMs: config\.uploadExtractWaitMs/, 'an upload response never waits for the whole conversion');
});
