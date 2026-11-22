/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Langfuse read filter, deep link and judge SCORE — checklist A20, A22 and A23
 * USER STORY: As a security reviewer I need proof that no Langfuse read the OS performs can be
 *             unfiltered, and that the run's "Trace" link opens ONE trace, not a list.
 * ARCHITECTURE: pure functions from `core/infra/langfuse.ts`, plus the REAL `@langfuse/client`
 *             pointed at a local HTTP listener for the score path (`LANGFUSE_URL` is set before
 *             the config loads); nothing leaves the machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A local listener standing in for the Langfuse API: it records every request body. */
const received: { url: string; body: string }[] = [];
/** Trace ids this fake Langfuse holds (for the deep-link probe). */
const existingTraces = new Set<string>();
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ url: req.url ?? '', body });
    const trace = (req.url ?? '').match(/^\/api\/public\/traces\/([^/?]+)$/);
    if (trace) {
      res.writeHead(existingTraces.has(decodeURIComponent(trace[1])) ? 200 : 404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(207, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ successes: [], errors: [] }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
server.unref();
process.env.LANGFUSE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
process.env.LANGFUSE_SECRET_KEY = 'sk-test';

const { observationsQuery, traceUrlFor, scoreTrace, flushLangfuse, langfuseTraceId, UnfilteredLangfuseQueryError } = await import('@core/infra/langfuse');
const { config } = await import('@core/kernel/config');
const { __setMaskingForTests } = await import('@core/infra/masking-policy');

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

test('LANGFUSE-LINK: the trace URL deep-links to ONE run trace, id = createTraceId(runId) (A20), never the traces list', async () => {
  const runId = 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  const url = await traceUrlFor(runId);
  assert.equal(url, `${config.langfuseConsoleUrl}/trace/${await langfuseTraceId(runId)}`);
  assert.match(url!, /\/trace\/[0-9a-f]{32}$/);
  assert.ok(!url!.endsWith('/traces'), 'the A2 link pointed at the list page');
  assert.equal(await traceUrlFor(''), undefined);
});

test('LANGFUSE-LINK: a run traced before the OTel writer links to its LEGACY trace id; an unknown run gets the new id', async () => {
  const oldRun = 'run_0ld00000-0000-4000-8000-000000000001';
  existingTraces.clear();
  existingTraces.add(oldRun); // pre-switch: trace id = raw run id
  assert.equal(await traceUrlFor(oldRun), `${config.langfuseConsoleUrl}/trace/${oldRun}`, 'the old run opens its own trace, not a not-found page');

  existingTraces.add(await langfuseTraceId(oldRun)); // resumed after the switch: the mapped trace exists too
  assert.equal(await traceUrlFor(oldRun), `${config.langfuseConsoleUrl}/trace/${await langfuseTraceId(oldRun)}`);

  const fresh = 'run_new00000-0000-4000-8000-000000000002';
  assert.equal(await traceUrlFor(fresh), `${config.langfuseConsoleUrl}/trace/${await langfuseTraceId(fresh)}`, 'neither exists yet: the new id');
  const probes = received.length;
  assert.equal(await traceUrlFor(fresh, { probe: false }), `${config.langfuseConsoleUrl}/trace/${await langfuseTraceId(fresh)}`);
  assert.equal(received.length, probes, 'probe:false makes no request');
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
test('LANGFUSE-SCORE: the judge verdict lands on the RUN trace as a score (A22)', async () => {
  const runId = 'run_1b4e28ba-2fa1-11d2-883f-0016d3cca427';
  received.length = 0;
  // The masking switch is read as OFF (an unread switch would mask the comment: see langfuse-masking-failsafe.test.ts).
  __setMaskingForTests({ enabled: false, level: 'pii' });
  assert.equal(
    await scoreTrace({ runId, name: 'llm-judge', value: 0.75, comment: 'mostly grounded', metadata: { rubric: 'v2' } }),
    true,
    'scoreTrace reported failure with a configured client',
  );
  await flushLangfuse();
  const events = received.flatMap((r) => (JSON.parse(r.body || '{}') as { batch?: { type: string; body: Record<string, unknown> }[] }).batch ?? []);
  const scores = events.filter((e) => e.type === 'score-create');
  assert.equal(scores.length, 1, `expected exactly one score event, got ${events.map((e) => e.type).join(', ')}`);
  const body = scores[0].body;
  // The score is attached to the RUN's trace — the trace id derived from the run id.
  assert.equal(body.traceId, await langfuseTraceId(runId), 'the score is not attached to the run trace');
  assert.equal(body.name, 'llm-judge');
  assert.equal(body.value, 0.75);
  assert.equal(body.comment, 'mostly grounded');
  // It is a SCORE, not an observation.
  assert.ok(!events.some((e) => e.type.startsWith('generation-') || e.type.startsWith('span-')), 'a score must not create an observation');
});
