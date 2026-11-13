/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A4 review M-3 — the panel re-attaches instead of lying about the run
 * USER STORY: As a builder watching a run longer than the server's 240-second tail budget I want
 *             the panel to keep following it from the cursor the server handed back — never "please
 *             run again" for a run that is still executing, and never a replay of the whole run.
 * ARCHITECTURE: The pure half of the panel's stream reader (`build/run-stream-client.ts`). A test
 *             must not import a `.tsx`, which is exactly why the decision lives here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRunOver, parseSseChunk, reattachFrom, runStreamUrl, REATTACH_LIMIT } from '@tabs/agents/lib/build/run-stream-client';

test('M-3: a frame split across network chunks is decoded exactly once', () => {
  const first = parseSseChunk('', 'event: node-started\ndata: {"node":"a"}\n\nevent: tool-ste');
  assert.deepEqual(first.frames, [{ event: 'node-started', data: { node: 'a' } }]);
  const second = parseSseChunk(first.rest, 'p\ndata: {"tool":"t"}\n\n');
  assert.deepEqual(second.frames, [{ event: 'tool-step', data: { tool: 't' } }]);
  assert.equal(second.rest, '');
});

test('M-3: an unreadable frame is dropped, not thrown, and never stops the stream', () => {
  const out = parseSseChunk('', 'event: done\ndata: {not json}\n\nevent: done\ndata: {"ok":true}\n\n: heartbeat\n\n');
  assert.deepEqual(out.frames, [{ event: 'done', data: { ok: true } }]);
});

test('M-3: a `queued` frame is a CURSOR — it re-attaches from afterSeq, not from zero', () => {
  const again = reattachFrom({ event: 'queued', data: { runId: 'run_1', afterSeq: 37 } });
  assert.deepEqual(again, { runId: 'run_1', afterSeq: 37 });
  assert.equal(runStreamUrl('sys-1', 'run_1', 37), '/api/agents/systems/sys-1/run/stream?runId=run_1&afterSeq=37');
});

test('M-3: a `queued` frame with no runId falls back to the run being followed', () => {
  assert.deepEqual(reattachFrom({ event: 'queued', data: { afterSeq: 2 } }, 'run_9'), { runId: 'run_9', afterSeq: 2 });
  assert.equal(reattachFrom({ event: 'queued', data: {} }, undefined), null, 'no run to follow = nothing to re-attach to');
  assert.deepEqual(reattachFrom({ event: 'queued', data: { runId: 'run_1' } }), { runId: 'run_1', afterSeq: 0 });
  assert.deepEqual(reattachFrom({ event: 'queued', data: { runId: 'run_1', afterSeq: -5 } }), { runId: 'run_1', afterSeq: 0 });
});

test('M-3: every other frame is NOT a re-attach', () => {
  for (const event of ['node-started', 'tool-step', 'node-completed', 'approval-required', 'resumed', 'done', 'error']) {
    assert.equal(reattachFrom({ event, data: { runId: 'run_1', afterSeq: 1 } }), null, event);
  }
});

test('M-3: the run is over on `error` and on a done that is not parked — a parked done keeps watching', () => {
  assert.equal(isRunOver({ event: 'error', data: { error: 'boom' } }), true);
  assert.equal(isRunOver({ event: 'done', data: { reachedEnd: true } }), true);
  assert.equal(isRunOver({ event: 'done', data: { parked: true } }), false, 'the decision resumes the SAME run id');
  assert.equal(isRunOver({ event: 'node-started', data: {} }), false);
});

test('M-3: the re-attach chain is bounded', () => {
  assert.ok(REATTACH_LIMIT >= 10 && REATTACH_LIMIT <= 200, 'bounded, but long enough for a multi-hour run');
});

test('M-3: the panel uses the shared parser and the re-attach decision (source tripwire)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../ui/BuildRunPanel.tsx', import.meta.url), 'utf8');
  assert.match(src, /parseSseChunk\(buf, decoder\.decode/, 'frame splitting is not duplicated in the TSX');
  assert.match(src, /reattachFrom\(frame, cursor\.runId\)/, 'the re-attach stream follows a queued cursor');
  assert.match(src, /reattachFrom\(frame, resumeRunId\)/, 'so does the POST run stream');
  assert.doesNotMatch(src, /run\/stream\?runId=\$\{encodeURIComponent\(runId\)\}`/, 'the URL (with its cursor) comes from runStreamUrl');
});
