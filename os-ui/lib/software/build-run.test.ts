/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunError, buildMaxIterations } from './build-run.ts';
import { AssistantNotConfiguredError } from '@/lib/assistant/complete';

/**
 * 0.6.110 — the streamed Build chat run's HONEST failure + iteration budget helpers.
 *
 * B1: a NON-abort build failure surfaces the REAL, typed cause (model / tool /
 *     compile / repo error) — NOT a blanket "LiteLLM unreachable" — and fires the
 *     `{ type: 'error', message }` SSE event. Only a genuine gateway outage says
 *     unreachable; a client-abort stays SILENT (no error event).
 * B2: BUILD mode gets the configured tool-call-round budget (24) passed to
 *     runTabAgent; read-only modes (plan/test/review) do NOT (default, undefined).
 */

// --------------------------------------------------------------- B1: honest error --

test('B1: a model 400 surfaces its REAL message + an error event — not "unreachable"', () => {
  const { content, errorMessage } = buildRunError(new Error('LiteLLM 400: invalid tool schema'));
  // The real cause is preserved (model kind) — the old code lied "LiteLLM unreachable" here.
  assert.match(errorMessage ?? '', /model error/i);
  assert.match(errorMessage ?? '', /400/);
  assert.doesNotMatch(errorMessage ?? '', /unreachable/i);
  // The final-bubble content carries the same honest message.
  assert.match(content, /400/);
});

test('B1: a compile/tool/repo error surfaces its own message, not a gateway lie', () => {
  const { content, errorMessage } = buildRunError(new Error('commit rejected: TS2339 on Page.tsx'));
  assert.equal(errorMessage, 'commit rejected: TS2339 on Page.tsx');
  assert.match(content, /TS2339/);
  assert.doesNotMatch(errorMessage ?? '', /unreachable/i);
});

test('B1: a GENUINE gateway outage is the only case that says unreachable', () => {
  const { errorMessage } = buildRunError(new Error('fetch failed: ECONNREFUSED'));
  assert.match(errorMessage ?? '', /unreachable/i);
});

test('B1: a client-abort stays SILENT — no error event fires', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { content, errorMessage } = buildRunError(abort);
  assert.equal(errorMessage, null, 'no {type:error} event on a client abort');
  assert.match(content, /warming up/i);
});

test('B1: an unconfigured assistant is a soft note — no error event', () => {
  const { content, errorMessage } = buildRunError(new AssistantNotConfiguredError('no model key'));
  assert.equal(errorMessage, null);
  assert.match(content, /no model key/);
});

// --------------------------------------------------------- B2: build iteration cap --

test('B2: BUILD mode passes the configured budget (24) to the agent run', () => {
  assert.equal(buildMaxIterations('build'), 24);
});

test('B2: read-only modes pass NO budget (undefined ⇒ runAgentic default)', () => {
  assert.equal(buildMaxIterations('plan'), undefined);
  assert.equal(buildMaxIterations('test'), undefined);
  assert.equal(buildMaxIterations('review'), undefined);
});
