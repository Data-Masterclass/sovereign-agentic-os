/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring run rows open their own Langfuse trace on the operators' Langfuse host
 * USER STORY: As an operator I want each run row of an agent's Monitoring detail to open THAT
 *             run's trace in Langfuse (on the host the chart publishes, LANGFUSE_CONSOLE_URL),
 *             and no link at all where Langfuse has no browser address or the run is not a
 *             Langfuse trace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTraceLink } from '@tabs/monitoring/lib/trace-link';

const HOST = 'https://langfuse.dev.agentic.datamasterclass.com';

test('a Langfuse run row links to its own trace on the console host', () => {
  assert.equal(runTraceLink(HOST, { id: 'abc123', source: 'live' }), `${HOST}/trace/abc123`);
});

test('the trace id is URL-encoded, and a trailing slash on the host is not doubled', () => {
  assert.equal(runTraceLink(`${HOST}/`, { id: 'a/b c', source: 'live' }), `${HOST}/trace/a%2Fb%20c`);
});

test('negative twin: no console host (Langfuse not published) => no link', () => {
  assert.equal(runTraceLink('', { id: 'abc123', source: 'live' }), undefined);
});

test('negative twin: an in-process ring record is not a Langfuse trace => no link', () => {
  assert.equal(runTraceLink(HOST, { id: 'ring-1', source: 'ring' }), undefined);
  assert.equal(runTraceLink(HOST, { id: 'm-1', source: 'mock' }), undefined);
});

test('negative twin: an empty trace id => no link', () => {
  assert.equal(runTraceLink(HOST, { id: '', source: 'live' }), undefined);
});
