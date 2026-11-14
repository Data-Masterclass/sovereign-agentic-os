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
import { fetchTrace, outputFailed, traceOwner, traceDomain, UNKNOWN_DOMAIN } from '@tabs/monitoring/lib/adapters/run-trace';
import { canSee, deriveScope, filterScope } from '@tabs/monitoring/lib/scope-core';

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

test('X-R4: the domain is never the empty string, and never a guess (review M-1)', () => {
  assert.equal(traceDomain({ domain: 'sales' }), 'sales', 'a declared domain is used as declared');
  assert.equal(traceDomain({ domain: '' }), UNKNOWN_DOMAIN, "an EMPTY declared domain no longer passes through (`??` guarded only undefined)");
  assert.equal(traceDomain({ domain: '   ' }), UNKNOWN_DOMAIN, 'nor does whitespace count as a domain');
  assert.equal(traceDomain({}), UNKNOWN_DOMAIN);
  // The sentinel must be unusable as a real domain id, or it would be a gate bypass of its own.
  assert.match(UNKNOWN_DOMAIN, /[()]/, 'it contains characters no OS domain id can contain');
});

test('M-1: a domain-less run is NOT visible to a builder whose domain name occurs in the principal', () => {
  // The exact leak: `principalDomain('sales-bot@acme')` returns 'sales' by substring, so the
  // first version of the X-R4 fix handed a domain-less run the domain 'sales' — and `canSee`
  // gates a builder on `scope.domains.includes(it.domain)`.
  const owner = 'sales-bot@acme';
  const item = { id: 'run_x', owner, domain: traceDomain({ domain: '' }, owner) };
  const builderOfSales = deriveScope('builder', 'ben', ['sales']);

  assert.equal(canSee(builderOfSales, item), false, 'M-1: a guessed domain must not grant visibility');
  assert.deepEqual(filterScope(builderOfSales, [item]), [], 'and the LIST is filtered too, not only the drill-in');
  const domainAdminOfSales = deriveScope('domain_admin', 'dana', ['sales']);
  assert.equal(canSee(domainAdminOfSales, item), false, 'a domain admin is gated the same way');

  // Visibility rests where it should: on ownership, and on admin.
  assert.equal(canSee(deriveScope('creator', owner, []), item), true, 'the owner still sees their own run');
  assert.equal(canSee(deriveScope('builder', owner, ['sales']), item), true, 'and a builder who owns it does');
  assert.equal(canSee(deriveScope('admin', 'ada', ['sales']), item), true, 'an admin sees everything, as before');
  // A run that DOES declare its domain is still domain-visible — the fix narrows nothing real.
  assert.equal(canSee(builderOfSales, { owner, domain: traceDomain({ domain: 'sales' }, owner) }), true);
});

test('M-2: an allowed tool that reports its own failure does not read green', () => {
  // No `isError`, no `failed` — an allowed tool returning its own outcome shape. Under the
  // narrow flag set this read GREEN, which is a quieter lie than the one X-R3 fixed.
  assert.equal(outputFailed({ ok: false, reason: 'the upstream call failed' }), true, 'ok:false is a failure');
  assert.equal(outputFailed({ ok: true, rows: 42 }), false, 'ok:true is not');
  assert.equal(outputFailed({ success: false, detail: 'denied by policy' }), true);
  assert.equal(outputFailed({ error: 'connection refused' }), true, 'a non-empty error field is a failure');
  assert.equal(outputFailed({ error: null, rows: 1 }), false, 'an empty error field is not');
  assert.equal(outputFailed({ error: false, rows: 1 }), false);
  // A flagless object is probed by its string VALUES — never by its key names, which is the
  // distinction the whole X-R3 fix rests on.
  assert.equal(outputFailed({ reason: 'the dbt build failed' }), true, 'a failure word in a VALUE counts');
  assert.equal(outputFailed({ isErrorCount: 0, failedRows: 0, note: 'all clear' }), false, 'key names never count');
  assert.equal(outputFailed({ summary: 'timed out after 30s' }), true);
  // And the flags still win over the text, in both directions.
  assert.equal(outputFailed({ isError: false, reason: 'no error rows found' }), false, 'a present flag is authoritative');
  assert.equal(outputFailed({ ok: false, reason: 'all good' }), true);
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

test('X-R4/M-1: a run that records nobody says so, and is not visible on a guessed domain', async () => {
  serve({ id: 't_anon', name: 'run', userId: 'sales-bot@acme', output: { failed: false }, metadata: {}, observations: [] });
  const trace = await fetchTrace('t_anon');
  assert.equal(trace?.owner, 'sales-bot@acme', 'the owner comes from the trace, not from a guess');
  assert.equal(trace?.domain, UNKNOWN_DOMAIN, 'never the empty string and never a derived domain');
  assert.equal(canSee(deriveScope('builder', 'ben', ['sales']), trace!), false, 'so a sales builder cannot drill into it');

  serve({ id: 't_none', name: 'run', output: { failed: false }, metadata: {}, observations: [] });
  assert.equal((await fetchTrace('t_none'))?.owner, 'unknown', 'and with nothing recorded at all, honestly unknown');
});
