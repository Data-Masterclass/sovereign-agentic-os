/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        monitoring
 * FEATURE:    Trace read-back honesty — a successful step reads back as success (X-R3/X-R4)
 * USER STORY: As an operator I want `get_run_trace` and the Monitoring drill-in to tell me which
 *             steps FAILED — so when every tool call in a healthy run is labelled `error` and the
 *             run header says the owner is `unknown`, the surface is useless and I stop trusting it.
 * ARCHITECTURE:
 *   - The payloads here are the ones `tabs/agents/lib/engine/observe.ts` actually writes: a tool
 *     span's output is `{ isError, text }`, `run.result`'s output is the outcome `{ failed, … }`,
 *     and the acting user is on the TRACE's `userId`, not in `metadata.principal`.
 *   - `fetchTrace` is driven end-to-end over a stubbed `globalThis.fetch` (the adapter's only
 *     outbound call), so the assertions are about the adapter's real output shape, not a helper.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTrace, outputFailed, traceOwner, traceDomain } from '@tabs/monitoring/lib/adapters/run-trace';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every outbound read with this Langfuse payload. */
function serve(payload: unknown): void {
  globalThis.fetch = (async () => ({ ok: true, text: async () => JSON.stringify(payload) })) as unknown as typeof fetch;
}

// ----------------------------------------------------------- the status mapping ---

test('X-R3: a SUCCESSFUL tool payload is not an error — the key name "isError" is not a verdict', () => {
  // This is the exact output `observe.ts` writes for a tool that worked.
  assert.equal(outputFailed({ isError: false, text: 'rows: 42' }), false);
  // …and for one that did not.
  assert.equal(outputFailed({ isError: true, text: '{"code":"not_found"}' }), true);
  // A `false` flag is authoritative even when the TEXT mentions an error (a tool reporting on a
  // failure it handled is not itself a failed step).
  assert.equal(outputFailed({ isError: false, text: 'no error rows found' }), false);
});

test('X-R3: run.result with failed:false is not an error — the key name "failed" is not a verdict', () => {
  assert.equal(outputFailed({ failed: false, output: 'done' }), false);
  assert.equal(outputFailed({ failed: true, error: 'node threw' }), true);
});

test("X-R3: Langfuse's own level still wins, and a textual output is still probed", () => {
  assert.equal(outputFailed({ isError: false }, 'ERROR'), true, 'an ERROR level is authoritative');
  assert.equal(outputFailed('aborted after 3 retries'), true, 'a text output is probed as text');
  assert.equal(outputFailed('42 rows'), false);
  assert.equal(outputFailed(undefined), false, 'no output is not a failure');
  assert.equal(outputFailed(null), false);
});

// ------------------------------------------------------------- owner and domain ---

test('X-R4: the owner comes from the trace userId when no delegated principal was recorded', () => {
  assert.equal(traceOwner({ userId: 'amir' }, { systemId: 'sys_1' }), 'amir', 'the agent-run shape');
  assert.equal(traceOwner({ userId: 'amir' }, { principal: 'sara' }), 'sara', 'a delegated principal wins');
  assert.equal(traceOwner({}, {}), 'unknown', 'and nothing recorded is still honestly unknown');
  assert.equal(traceOwner({ userId: '  ' }, {}), 'unknown', 'blank is not an owner');
});

test('X-R4: the domain is never the empty string', () => {
  assert.equal(traceDomain({ domain: 'sales' }, 'amir'), 'sales');
  assert.equal(traceDomain({ domain: '' }, 'sales-bot'), 'sales', "an EMPTY declared domain falls back (`??` did not)");
  assert.equal(traceDomain({ domain: '   ' }, 'finance-svc'), 'finance', 'nor does whitespace count as a domain');
  assert.equal(traceDomain({}, 'unknown'), 'unknown');
});

// --------------------------------------------------------- the read-back, end to end ---

const AGENT_TRACE = {
  id: 'run_9f1',
  name: 'Revenue review',
  userId: 'amir',
  timestamp: '2026-11-14T02:00:00.000Z',
  output: { failed: false, output: 'Revenue was 1.2M' },
  metadata: { systemId: 'sys_abc', domain: 'sales', engine: 'langgraph', runId: 'run_9f1' },
  observations: [
    {
      type: 'SPAN',
      name: 'tool.query_data',
      level: 'DEFAULT',
      startTime: '2026-11-14T02:00:01.000Z',
      input: { tool: 'query_data', callId: 'c1', args: { sql: 'select 1' } },
      output: { isError: false, text: 'rows: 42' },
      latency: 120,
    },
    {
      type: 'SPAN',
      name: 'run.result',
      level: 'DEFAULT',
      startTime: '2026-11-14T02:00:03.000Z',
      output: { failed: false, output: 'Revenue was 1.2M' },
    },
    {
      type: 'SPAN',
      name: 'tool.write_file',
      level: 'ERROR',
      startTime: '2026-11-14T02:00:02.000Z',
      output: { isError: true, text: '{"code":"forbidden"}' },
      statusMessage: 'policy denied',
    },
  ],
};

test('X-R3/X-R4: a healthy agent run reads back green, owned, with per-step truth', async () => {
  serve(AGENT_TRACE);
  const trace = await fetchTrace('run_9f1');
  assert.ok(trace);
  assert.equal(trace.source, 'live', 'the live payload was used, not the offline mock');

  const byName = new Map(trace.steps.map((s) => [s.name, s]));
  // Before the fix: BOTH of these were 'error', because their payloads contain the key names
  // "isError" and "failed" and the verdict was a substring grep over the serialized output.
  assert.equal(byName.get('tool.query_data')?.status, 'ok', 'X-R3: a successful tool span is ok');
  assert.equal(byName.get('run.result')?.status, 'ok', 'X-R3: failed:false is not an error');
  assert.equal(byName.get('tool.write_file')?.status, 'error', 'a real failure is still an error');

  assert.equal(trace.owner, 'amir', 'X-R4: the owner is the acting user, not "unknown"');
  assert.equal(trace.domain, 'sales', "X-R4: and the domain is the run's domain, not ''");
  assert.equal(trace.health, 'green', 'a run whose outcome says failed:false is not red');
});

test('X-R3: the derived log lines agree with the step statuses', async () => {
  serve(AGENT_TRACE);
  const trace = await fetchTrace('run_9f1');
  const line = (needle: string) => trace?.logs.find((l) => l.includes(needle)) ?? '';
  assert.match(line('tool.query_data'), /\bDEFAULT\b/, 'a successful tool is not logged at ERROR');
  assert.match(line('run.result'), /\bDEFAULT\b/);
  assert.match(line('tool.write_file'), /\bERROR\b/, 'the real failure still is');
});

test('X-R4: a run that records nobody still says so, rather than inventing an owner', async () => {
  serve({ id: 't_anon', name: 'run', output: { failed: false }, metadata: {}, observations: [] });
  const trace = await fetchTrace('t_anon');
  assert.equal(trace?.owner, 'unknown');
  assert.equal(trace?.domain, 'unknown', 'never the empty string');
});
