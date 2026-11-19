/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  previewViews, isPreviewViewId, previewViewStorageKey, nextPreviewView,
  extractedStatusLine, emptyTextMessage, autoDocsLine, SUGGESTED_WORD, SUGGESTED_TOOLTIP,
} from '@tabs/files/lib/preview-views';

const fmt = (iso: string) => `on ${iso.slice(0, 10)}`;

test('a PDF or image offers Original, Extracted text and Details — Original first', () => {
  for (const mode of ['pdf', 'image']) {
    assert.deepEqual(previewViews(mode).map((v) => [v.id, v.label]),
      [['original', 'Original'], ['text', 'Extracted text'], ['details', 'Details']]);
  }
});

test('audio and video call the text view "Transcript"', () => {
  for (const mode of ['audio', 'video']) {
    assert.equal(previewViews(mode).find((v) => v.id === 'text')?.label, 'Transcript');
  }
});

test('no viewer mode (text file, CSV, unknown): no switch at all', () => {
  assert.deepEqual(previewViews(null), []);
  assert.deepEqual(previewViews(undefined), []);
  assert.deepEqual(previewViews('csv'), []);
});

test('only known view ids are accepted back from storage', () => {
  assert.equal(isPreviewViewId('text'), true);
  assert.equal(isPreviewViewId('details'), true);
  assert.equal(isPreviewViewId('representations'), false);
  assert.equal(isPreviewViewId(null), false);
  assert.equal(previewViewStorageKey('pdf'), 'files.preview.view.pdf');
});

test('arrow keys rove and wrap; Home/End jump; other keys do nothing', () => {
  const ids = previewViews('pdf').map((v) => v.id);
  assert.equal(nextPreviewView(ids, 'original', 'ArrowRight'), 'text');
  assert.equal(nextPreviewView(ids, 'details', 'ArrowRight'), 'original');
  assert.equal(nextPreviewView(ids, 'original', 'ArrowLeft'), 'details');
  assert.equal(nextPreviewView(ids, 'text', 'Home'), 'original');
  assert.equal(nextPreviewView(ids, 'text', 'End'), 'details');
  assert.equal(nextPreviewView(ids, 'text', 'Enter'), null);
  assert.equal(nextPreviewView([], 'text', 'ArrowRight'), null);
});

test('extracted: the status line carries the character count and the date', () => {
  const line = extractedStatusLine({ status: 'extracted', at: '2026-11-19T09:00:00.000Z', chars: 877 }, 877, fmt);
  assert.equal(line, 'Text extracted · 877 characters · on 2026-11-19');
});

test('extracted without a recorded count or date: falls back to the text length, omits the date', () => {
  assert.equal(extractedStatusLine({ status: 'extracted', at: '' }, 12345, fmt), 'Text extracted · 12,345 characters');
  assert.equal(extractedStatusLine({ status: 'extracted', chars: 1 }, 0, fmt), 'Text extracted · 1 character');
});

test('pending, failed or never extracted: no "extracted" line', () => {
  assert.equal(extractedStatusLine({ status: 'pending', at: '2026-11-19T09:00:00.000Z' }, 0, fmt), '');
  assert.equal(extractedStatusLine({ status: 'failed', at: '2026-11-19T09:00:00.000Z' }, 0, fmt), '');
  assert.equal(extractedStatusLine(undefined, 500, fmt), '');
});

test('empty text view — pending: says it is extracting, whatever else is recorded', () => {
  const msg = emptyTextMessage({ extracting: true, storedWhy: '', transcript: false });
  assert.match(msg, /^Extracting text…/);
});

test('empty text view — failed with a reason: the reason, verbatim', () => {
  const why = 'Not searchable: the document parser timed out.';
  assert.equal(emptyTextMessage({ extracting: false, storedWhy: why, transcript: false }), why);
});

test('empty text view — stored only by choice and restricted: the pane\'s own sentence', () => {
  const optOut = 'Opted out of indexing by its owner.';
  const restricted = 'Restricted files are stored but never parsed or indexed.';
  assert.equal(emptyTextMessage({ extracting: false, storedWhy: optOut, transcript: false }), optOut);
  assert.equal(emptyTextMessage({ extracting: false, storedWhy: restricted, transcript: true }), restricted);
});

test('empty text view — nothing recorded: a plain statement, worded for the kind', () => {
  assert.equal(emptyTextMessage({ extracting: false, storedWhy: '', transcript: false }), 'No extracted text is stored for this file.');
  assert.equal(emptyTextMessage({ extracting: false, storedWhy: '', transcript: true }), 'No transcript is stored for this file.');
});

// ---- automatic description + tags: the one line Details shows ----

const base = { restricted: false, optedOut: false, hasText: true, extracting: false, hasDescription: false, canManage: true };

test('auto-docs line — pending says "Writing a description…" and offers nothing', () => {
  assert.deepEqual(autoDocsLine({ ...base, generation: { status: 'pending' } }), { text: 'Writing a description…', pending: true, action: null });
});

test('auto-docs line — a failure shows its recorded reason with "Try again" for whoever may edit', () => {
  const reason = 'No description was written: the model could not be reached.';
  assert.deepEqual(autoDocsLine({ ...base, generation: { status: 'failed', reason } }), { text: reason, pending: false, action: 'retry' });
  assert.equal(autoDocsLine({ ...base, canManage: false, generation: { status: 'failed', reason } })?.action, null);
});

test('auto-docs line — a restricted file says why nothing was written and offers no action, even after a failure was recorded', () => {
  const line = autoDocsLine({ ...base, restricted: true, generation: { status: 'failed', reason: 'x' } });
  assert.match(line?.text ?? '', /^Restricted files are never sent to a model/);
  assert.equal(line?.action, null);
  assert.equal(autoDocsLine({ ...base, optedOut: true })?.action, null);
  assert.match(autoDocsLine({ ...base, optedOut: true })?.text ?? '', /owner’s choice/);
});

test('auto-docs line — no text: nothing to describe; still extracting: silent; otherwise Regenerate for the editor only', () => {
  assert.match(autoDocsLine({ ...base, hasText: false })?.text ?? '', /there is no text to describe/);
  assert.equal(autoDocsLine({ ...base, hasText: false, extracting: true }), null);
  assert.deepEqual(autoDocsLine({ ...base, hasDescription: true, generation: { status: 'done' } }), { text: '', pending: false, action: 'regenerate' });
  assert.equal(autoDocsLine({ ...base, canManage: false, hasDescription: true }), null);
});

test('the marker is a plain word with the documented tooltip', () => {
  assert.equal(SUGGESTED_WORD, 'suggested');
  assert.equal(SUGGESTED_TOOLTIP, 'Written automatically from the file’s content. Edit to change.');
});
