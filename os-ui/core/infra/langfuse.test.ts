/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Langfuse read filter + deep link — checklist A20 and A23
 * USER STORY: As a security reviewer I need proof that no Langfuse read the OS performs can be
 *             unfiltered, and that the run's "Trace" link opens ONE trace, not a list.
 * ARCHITECTURE: pure functions from `core/infra/langfuse.ts`; no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationsQuery, traceUrlFor, UnfilteredLangfuseQueryError } from '@core/infra/langfuse';
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
