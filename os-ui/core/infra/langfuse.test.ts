/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Langfuse read filter, deep link and judge SCORE — checklist A20, A22 and A23
 * USER STORY: As a security reviewer I need proof that no Langfuse read the OS performs can be
 *             unfiltered, and that the run's "Trace" link opens ONE trace, not a list.
 * ARCHITECTURE: pure functions from `core/infra/langfuse.ts`, plus the REAL SDK with its
 *             transport replaced for the score path (injected through `__setLangfuseClientForTests`);
 *             nothing leaves the process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Langfuse } from 'langfuse';
import type { LangfuseFetchOptions, LangfuseFetchResponse } from 'langfuse-core';
import { observationsQuery, traceUrlFor, scoreTrace, __setLangfuseClientForTests, UnfilteredLangfuseQueryError } from '@core/infra/langfuse';
import { config } from '@core/kernel/config';

test('LANGFUSE-READ: an unfiltered observations query is refused, typed (A23)', () => {
  assert.throws(() => observationsQuery({}), UnfilteredLangfuseQueryError);
  assert.throws(() => observationsQuery({ limit: 100, type: 'GENERATION' }), UnfilteredLangfuseQueryError);
  // A user without a time bound is still too broad; a time bound without a user too.
  assert.throws(() => observationsQuery({ userId: 'rae' }), UnfilteredLangfuseQueryError);
  assert.throws(() => observationsQuery({ fromTimestamp: '2026-11-13T00:00:00.000Z' }), UnfilteredLangfuseQueryError);
  assert.throws(() => observationsQuery({ traceId: '   ' }), UnfilteredLangfuseQueryError);
});

test('LANGFUSE-READ: a run-scoped query filters by the trace id (= run id) and nothing wider', () => {
  const q = new URLSearchParams(observationsQuery({ traceId: 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427', type: 'GENERATION' }));
  assert.equal(q.get('traceId'), 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  assert.equal(q.get('type'), 'GENERATION');
  assert.equal(q.get('userId'), null);
  assert.equal(q.get('limit'), '100');
});

test('LANGFUSE-READ: without a run id the query is bounded to the user AND a time window', () => {
  const q = new URLSearchParams(observationsQuery({ userId: 'rae', fromTimestamp: '2026-11-13T10:00:00.000Z', limit: 500 }));
  assert.equal(q.get('userId'), 'rae');
  assert.equal(q.get('fromTimestamp'), '2026-11-13T10:00:00.000Z');
  assert.equal(q.get('limit'), '100', 'the page size is capped');
});

test('LANGFUSE-LINK: the trace URL deep-links to ONE run trace (A20), never the traces list', () => {
  const url = traceUrlFor('run_1b4e28ba-2fa1-11d2-883f-0016d3cca427');
  assert.equal(url, `${config.langfuseConsoleUrl}/trace/run_1b4e28ba-2fa1-11d2-883f-0016d3cca427`);
  assert.ok(!url!.endsWith('/traces'), 'the A2 link pointed at the list page');
  assert.equal(traceUrlFor(''), undefined);
});

// ------------------------------------------------------------------ A22 --

/**
 * A22 — the LLM-judge verdict is written as a Langfuse SCORE on the run trace.
 *
 * Part F found this row cited THIS file for `scoreTrace` while the file never called it: the only
 * thing exercising `scoreTrace` anywhere was a source-ordering tripwire in
 * `core/mcp/agent-run-surface.test.ts` that greps the route for the string. So the "true at the
 * client" half of A22 rested on no behavioural test at all. These three close that: the REAL SDK
 * with its transport replaced (nothing leaves the process), injected through the module's own test
 * seam, asserting what lands on the wire.
 */
class RecordingLangfuse extends Langfuse {
  events: { type: string; body: Record<string, unknown> }[] = [];
  constructor() {
    super({ publicKey: 'pk-test', secretKey: 'sk-test', baseUrl: 'http://langfuse.test', flushAt: 1000, flushInterval: 60_000 });
  }
  override async fetch(_url: string, options: LangfuseFetchOptions): Promise<LangfuseFetchResponse> {
    const body = JSON.parse(String(options.body ?? '{}')) as { batch?: { id: string; type: string; body: Record<string, unknown> }[] };
    this.events.push(...(body.batch ?? []));
    const ok = { successes: (body.batch ?? []).map((e) => ({ id: e.id, status: 201 })), errors: [] };
    return { status: 207, text: async () => JSON.stringify(ok), json: async () => ok, arrayBuffer: async () => new ArrayBuffer(0) };
  }
}

test('LANGFUSE-SCORE: the judge verdict lands on the RUN trace as a score (A22)', async () => {
  const client = new RecordingLangfuse();
  __setLangfuseClientForTests(client);
  try {
    const runId = 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427';
    assert.equal(
      scoreTrace({ traceId: runId, name: 'llm-judge', value: 0.75, comment: 'mostly grounded', metadata: { rubric: 'v2' } }),
      true,
      'scoreTrace reported failure with a configured client',
    );
    await client.flushAsync();
    const scores = client.events.filter((e) => e.type.startsWith('score-'));
    assert.equal(scores.length, 1, `expected exactly one score event, got ${client.events.map((e) => e.type).join(', ')}`);
    const body = scores[0].body;
    // The score is attached to the RUN's trace — trace id = run id is the whole point (A19).
    assert.equal(body.traceId, runId, 'the score is not attached to the run trace');
    assert.equal(body.name, 'llm-judge');
    assert.equal(body.value, 0.75);
    assert.equal(body.comment, 'mostly grounded');
    // It is a SCORE, not an observation: no score may be created as a span/generation.
    assert.ok(!client.events.some((e) => e.type.startsWith('generation-') || e.type.startsWith('span-')), 'a score must not create an observation');
  } finally {
    __setLangfuseClientForTests(undefined);
  }
});

test('LANGFUSE-SCORE: with Langfuse unconfigured, scoring is a reported no-op, never a throw (A22)', () => {
  __setLangfuseClientForTests(null);
  try {
    assert.equal(scoreTrace({ traceId: 'run_x', name: 'llm-judge', value: 1 }), false, 'an unconfigured client must report false, not true');
  } finally {
    __setLangfuseClientForTests(undefined);
  }
});

test('LANGFUSE-SCORE: a throwing client is swallowed and reported, so a verdict never fails a run (A22)', () => {
  const broken = new RecordingLangfuse();
  broken.score = () => { throw new Error('ingestion queue closed'); };
  __setLangfuseClientForTests(broken);
  try {
    assert.equal(scoreTrace({ traceId: 'run_x', name: 'llm-judge', value: 1 }), false, 'a throwing client must be reported as false');
  } finally {
    __setLangfuseClientForTests(undefined);
  }
});
