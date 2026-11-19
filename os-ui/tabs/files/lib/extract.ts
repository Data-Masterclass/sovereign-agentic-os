/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Binary text extraction — read a stored document's text once, store it WITH the file
 * USER STORY: As someone who uploaded a PDF I want an agent calling `get_file` to read what the
 *             PDF says, and search to find it. And when the parser cannot read it I want the file
 *             kept, marked "Stored only" with the specific reason, and nothing made up.
 * ARCHITECTURE:
 *   - THE DEFECT. A PDF upload carried `text: ''`, `createFile` turned every empty-text upload
 *     into stored-only, and the index pipeline returns before any parser on stored-only — so the
 *     parser was never called for an uploaded PDF, `get_file` returned `text: ""`, and an agent
 *     run rejected twelve invoices as "no readable content".
 *   - EXTRACT → STORE → INDEX. The text is obtained once ({@link ExtractDeps.convert}: Docling,
 *     from the BYTES in the object store), written onto the file record
 *     (`store.applyExtractedText`) and only then indexed through the ordinary pipeline, which
 *     chunks that stored text. One body for `get_file`, the preview, lexical search and the
 *     vector index. The original bytes are read, never rewritten.
 *   - WAIT A LITTLE, THEN GET OUT OF THE WAY. A one-page PDF converts in ~1–4 s; a long scan
 *     takes minutes. The caller passes `waitMs`: the upload door waits that long for the common
 *     case (the response already says "Searchable ✓") and otherwise answers `pending` while the
 *     SAME promise finishes in this process and writes its result. There is no queue to move it
 *     to: the file registry is in-process state of os-ui, which the `os-ui-worker` Deployment
 *     (a second process, agent runs only) cannot write. If the process is replaced mid-flight the
 *     record stays `pending`; `staleAfterMs` turns that into an honest `interrupted` the next
 *     time anyone looks, and the re-index / "Extract text" retries it.
 *   - NEVER FOR A DECISION. `store.extractionEligibility` is consulted before the bytes are read
 *     and AGAIN at the write: a `restricted` file or an owner's opt-out is never sent to the
 *     parser, and text that arrives after the owner restricted the file is dropped.
 *   - NO STAND-IN, UNDER ANY SETTING. Nothing here consults `OS_OFFLINE_MOCK`, because there is
 *     no fabricating branch to gate: a parser that is down yields a typed failure on a laptop
 *     exactly as in production.
 *   - Pure + injected ({@link ExtractDeps}); `pipeline-server.ts` wires the live defaults.
 */
import type { ExtractionFailureCode, FileAsset } from '@tabs/files/lib/asset-schema';
import type { DoclingDocument, DoclingOutcome } from '@tabs/files/lib/ingest/docling-client';
import {
  applyExtractedText,
  extractionSubject,
  markExtractionPending,
  objectKeyForAsset,
  recordExtractionFailure,
} from '@tabs/files/lib/store';

export type ExtractDeps = {
  /** Send the bytes to the parser. Resolves with text or a typed reason — never throws. */
  convert: (doc: DoclingDocument) => Promise<DoclingOutcome>;
  /** Read the original object. `null` = not there. */
  getBlob: (key: string) => Promise<{ body: Buffer; contentType: string } | null>;
  /** Index the file now that its text is stored (the ordinary upload pipeline). */
  index: (asset: FileAsset, text: string, actingUserId?: string) => Promise<void>;
};

export type ExtractResult =
  /** Text stored and handed to the indexer. */
  | { state: 'extracted'; chars: number; seconds: number }
  /** Still converting; it will finish in the background and write its own result. */
  | { state: 'pending' }
  /** The parser could not produce text; the reason is recorded on the file. */
  | { state: 'failed'; code: ExtractionFailureCode; reason: string }
  /** Not sent to the parser at all (policy, choice, already has text, not a document…). */
  | { state: 'skipped'; why: string };

/** One in-flight extraction per file per process — a double-click must not OCR twice. */
const FLIGHTS_KEY = Symbol.for('soa.files.extract.flights');
function flights(): Map<string, Promise<ExtractResult>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<ExtractResult>> | undefined>;
  if (!g[FLIGHTS_KEY]) g[FLIGHTS_KEY] = new Map();
  return g[FLIGHTS_KEY]!;
}

async function run(id: string, deps: ExtractDeps, actingUserId?: string): Promise<ExtractResult> {
  const subject = extractionSubject(id);
  if (!subject) return { state: 'skipped', why: 'the file is no longer stored' };
  if (!subject.eligibility.eligible) return { state: 'skipped', why: subject.eligibility.why };
  const { asset, object } = subject;

  const fail = (code: ExtractionFailureCode, reason: string): ExtractResult => {
    recordExtractionFailure(id, code, reason);
    // On the file (the preview, `get_file`) AND in the pod log — an operator looking for why a
    // batch of uploads is not searchable should not have to open each one.
    console.warn(`[files] text extraction failed for ${id} (${code}): ${reason}`);
    return { state: 'failed', code, reason };
  };

  markExtractionPending(id);
  const key = objectKeyForAsset(asset);
  let blob: { body: Buffer; contentType: string } | null = null;
  try {
    blob = key ? await deps.getBlob(key) : null;
  } catch (e) {
    return fail('bytes-missing', `The original file could not be read from the object store (${(e as Error).message || 'no response'}), so it was not sent to the parser.`);
  }
  if (!blob || blob.body.length === 0) {
    return fail('bytes-missing', 'The original file is not in the object store, so there was nothing to send to the parser.');
  }

  let outcome: DoclingOutcome;
  try {
    outcome = await deps.convert({ name: asset.name, bytes: blob.body, contentType: object?.contentType ?? blob.contentType });
  } catch (e) {
    // `convert` promises not to throw; if an injected one does, that is still not text.
    outcome = { ok: false, code: 'parser-unreachable', reason: `The document parser failed unexpectedly (${(e as Error).message || 'no detail'}).`, seconds: 0 };
  }
  if (!outcome.ok) return fail(outcome.code, outcome.reason);
  if (!outcome.text.trim()) {
    return fail('no-text', 'The document parser read the document and found no text in it — for example a scan on which OCR recognised nothing.');
  }

  // The write re-checks eligibility: restricted / opted out / deleted meanwhile ⇒ text dropped.
  const updated = applyExtractedText(id, outcome.text);
  if (!updated) {
    return { state: 'skipped', why: 'the file was restricted, opted out, changed or deleted while its text was being read — the text was discarded' };
  }
  // Indexing is best-effort exactly as for a text upload: the text is already stored (so
  // `get_file` and lexical search have it); a gateway outage must not undo that.
  await deps.index(updated, outcome.text, actingUserId).catch((e) => {
    console.warn(`[files] indexing after text extraction failed for ${id} — the text is stored: ${(e as Error)?.message ?? String(e)}`);
  });
  return { state: 'extracted', chars: outcome.text.length, seconds: outcome.seconds };
}

/**
 * Extract one file's text. Waits up to `waitMs` (default: until it is done) and then reports
 * `pending` while the work carries on. Concurrent calls for the same file share one flight.
 */
export async function extractFileText(
  id: string,
  deps: ExtractDeps,
  opts: { waitMs?: number; actingUserId?: string } = {},
): Promise<ExtractResult> {
  let flight = flights().get(id);
  if (!flight) {
    flight = run(id, deps, opts.actingUserId)
      .catch((e): ExtractResult => {
        const reason = `Text extraction stopped unexpectedly (${(e as Error).message || 'no detail'}).`;
        recordExtractionFailure(id, 'parser-error', reason);
        return { state: 'failed', code: 'parser-error', reason };
      })
      .finally(() => { flights().delete(id); });
    flights().set(id, flight);
  }
  if (opts.waitMs === undefined) return flight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<ExtractResult>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), Math.max(0, opts.waitMs!));
  });
  try {
    return await Promise.race([flight, pending]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Is an extraction for this file running in THIS process right now? */
export function extractionInFlight(id: string): boolean {
  return flights().has(id);
}

/**
 * A `pending` record with no flight behind it is a promise nobody is keeping: the process that
 * started it is gone. Past `staleAfterMs` it is rewritten as an honest, retryable `interrupted`.
 * Returns true when it rewrote the record.
 */
export function settleStaleExtraction(id: string, staleAfterMs: number, nowMs: number = Date.now()): boolean {
  const subject = extractionSubject(id);
  const ex = subject?.asset.indexing.extraction;
  if (!subject || ex?.status !== 'pending' || extractionInFlight(id)) return false;
  const startedAt = Date.parse(ex.at);
  if (Number.isFinite(startedAt) && nowMs - startedAt < staleAfterMs) return false;
  return Boolean(recordExtractionFailure(
    id,
    'interrupted',
    'Text extraction was started and never reported back (the server was restarted while it ran). Use “Extract text” to run it again.',
  ));
}

/** Test hook. */
export function __resetExtractFlights(): void {
  flights().clear();
}
