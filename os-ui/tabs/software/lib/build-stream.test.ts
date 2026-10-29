/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseFrames } from './build-stream.ts';

test('parseSseFrames decodes complete data frames and keeps the partial remainder', () => {
  const buf = 'data: {"type":"plan","text":"do it"}\n\ndata: {"type":"activi';
  const { events, rest } = parseSseFrames(buf);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'plan', text: 'do it' });
  assert.equal(rest, 'data: {"type":"activi'); // incomplete frame carried forward
});

test('parseSseFrames handles multiple frames in one chunk, in order', () => {
  const buf =
    'data: {"type":"activity","line":{"tool":"read_app_files","text":"Read the app files","isError":false}}\n\n' +
    'data: {"type":"activity","line":{"tool":"commit","text":"Committed 2 files","isError":false}}\n\n';
  const { events, rest } = parseSseFrames(buf);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'activity');
  assert.equal((events[1] as { line: { text: string } }).line.text, 'Committed 2 files');
  assert.equal(rest, '');
});

test('parseSseFrames skips a malformed frame without breaking the stream', () => {
  const buf = 'data: not json\n\ndata: {"type":"final","role":"assistant","content":"done"}\n\n';
  const { events } = parseSseFrames(buf);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'final');
});

test('parseSseFrames joins multi-line data payloads', () => {
  const buf = 'data: {"type":"plan",\ndata: "text":"multi"}\n\n';
  const { events } = parseSseFrames(buf);
  assert.deepEqual(events[0], { type: 'plan', text: 'multi' });
});
