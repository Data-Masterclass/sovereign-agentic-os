/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    Unit tests for the live scenario runner (allowlist refusal, assertions, SQL guard)
 * USER STORY: As the owner I want proof that the runner refuses every write in read-only mode
 *             BEFORE it reaches the network, and that its assertions mean what they say.
 * ARCHITECTURE:
 *   - `node --test scripts/scenarios/` — no dependencies, no network. A fake fetch counts calls
 *     so a refused step is proven never to have been sent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkToolAllowed, guardSql, evalPath, runAssertion, substitute, latencyStats, parseToolResponse, READ_ONLY_TOOLS, WRITE_TOOLS, NEVER_TOOLS } from './lib.mjs';
import { runScenario, Client, parseArgs } from './run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('read-only mode refuses every write tool and every unknown tool', () => {
  for (const t of WRITE_TOOLS) assert.equal(checkToolAllowed(t, { folder: '/_os-selftest' }, {}).ok, false, t);
  assert.equal(checkToolAllowed('run_agent_system', {}, {}).ok, false);
  assert.match(checkToolAllowed('upload_file', {}, {}).reason, /read-only/);
  assert.match(checkToolAllowed('drop_everything', {}, {}).reason, /not on the runner allowlist/);
  for (const t of READ_ONLY_TOOLS.filter((t) => t !== 'query_data')) assert.equal(checkToolAllowed(t, {}, {}).ok, true, t);
});

test('NEVER tools are refused even with --allow-write and a sandbox', () => {
  const opts = { allowWrite: true, sandboxFolder: '/_os-selftest', scenarioRequiresWrite: true };
  for (const t of NEVER_TOOLS) assert.equal(checkToolAllowed(t, {}, opts).ok, false, t);
  assert.equal(checkToolAllowed('approve_promotion', {}, opts).ok, false);
});

test('writes need allow-write AND a requiresWrite scenario AND a folder inside the sandbox', () => {
  const sb = { allowWrite: true, sandboxFolder: '/_os-selftest', scenarioRequiresWrite: true };
  assert.equal(checkToolAllowed('upload_file', { folder: '/_os-selftest/a' }, sb).ok, true);
  assert.equal(checkToolAllowed('upload_file', { folder: '/_OS-SELFTEST' }, sb).ok, true);
  assert.equal(checkToolAllowed('upload_file', { folder: '/invoices' }, sb).ok, false);
  assert.equal(checkToolAllowed('upload_file', { folder: '/_os-selftest-evil' }, sb).ok, false, 'prefix is not containment');
  assert.equal(checkToolAllowed('upload_file', {}, sb).ok, false, 'upload must name a folder');
  assert.equal(checkToolAllowed('upload_file', { folder: '/_os-selftest', scope: 'domain' }, sb).ok, false);
  assert.equal(checkToolAllowed('upload_file', { folder: '/_os-selftest' }, { ...sb, scenarioRequiresWrite: false }).ok, false);
  assert.equal(checkToolAllowed('upload_file', { folder: '/x' }, { ...sb, sandboxFolder: '/' }).ok, false);
  assert.throws(() => parseArgs(['--allow-write']), /sandbox-folder/);
});

test('query_data accepts only one bounded SELECT', () => {
  assert.equal(guardSql('SELECT COUNT(*) FROM t').ok, true);
  assert.equal(guardSql('select * from t limit 5').ok, true);
  assert.equal(guardSql('WITH a AS (SELECT 1) SELECT * FROM a LIMIT 1').ok, true);
  assert.equal(guardSql('select * from t').ok, false, 'unbounded');
  assert.equal(guardSql('select * from t limit 1000').ok, false);
  assert.equal(guardSql('DELETE FROM t').ok, false);
  assert.equal(guardSql('select 1; drop table t').ok, false);
  assert.equal(guardSql("select * from t where x = 'drop' limit 1").ok, true, 'a keyword inside a string literal is fine');
  assert.equal(checkToolAllowed('query_data', { sql: 'insert into t values (1)' }, {}).ok, false);
});

test('evalPath: keys, indexes, fan-out, filters, length', () => {
  const o = { a: [{ id: 'x', name: 'Invoice A', n: 1 }, { id: 'y', name: 'Other', n: 2 }], s: 'abc' };
  assert.equal(evalPath(o, 'a[0].id').value, 'x');
  assert.equal(evalPath(o, 'a.1.id').value, 'y');
  assert.deepEqual(evalPath(o, 'a[*].id').value, ['x', 'y']);
  assert.deepEqual(evalPath(o, 'a[?name~=invoice].id').value, ['x']);
  assert.deepEqual(evalPath(o, 'a[?n=2].id').value, ['y']);
  assert.equal(evalPath(o, 'a.length').value, 2);
  assert.equal(evalPath(o, 's.length').value, 3);
  assert.equal(evalPath(o, 'missing.deep').found, false);
  assert.equal(evalPath([7], '0').value, 7);
});

test('assertions pass and fail on the right inputs, and never echo content', () => {
  const r = { status: 'done', failed: false, text: 'Invoice total due 12', rows: [1, 2], names: ['a', 'b'] };
  assert.equal(runAssertion(r, { path: 'status', op: 'equals', value: 'done' }).ok, true);
  assert.equal(runAssertion(r, { path: 'status', op: 'equals', value: 'failed' }).ok, false);
  assert.equal(runAssertion(r, { path: 'rows', op: 'gte', value: 2 }).ok, true);
  assert.equal(runAssertion(r, { path: 'rows', op: 'lte', value: 1 }).ok, false);
  assert.equal(runAssertion(r, { path: 'text', op: 'containsAny', value: ['Total due', 'nope'] }).ok, true);
  assert.equal(runAssertion(r, { path: 'nope', op: 'exists' }).ok, false);
  assert.equal(runAssertion(r, { path: 'names', op: 'containsAll', value: ['a', 'c'] }).detail, 'missing: c');
  const f = runAssertion(r, { path: 'text', op: 'equals', value: 'x' });
  assert.equal(f.ok, false);
  assert.doesNotMatch(f.detail, /Invoice/, 'a failure describes the type/size, not the content');
  assert.equal(runAssertion({ g: 'call `list_files` then `fake_tool`' }, { path: 'g', op: 'backtickedNamesIn', value: ['list_files'] }).detail, 'not a tool: fake_tool');
});

test('substitute keeps types for a whole ${var} and interpolates inside strings', () => {
  const vars = { n: 12, ids: ['a', 'b'], fqn: 'iceberg.s.t' };
  assert.equal(substitute('${n}', vars), 12);
  assert.deepEqual(substitute({ x: '${ids}' }, vars), { x: ['a', 'b'] });
  assert.equal(substitute('SELECT 1 FROM ${fqn}', vars), 'SELECT 1 FROM iceberg.s.t');
  assert.equal(substitute('${ids.1}', vars), 'b');
});

test('latencyStats and parseToolResponse', () => {
  assert.deepEqual(latencyStats([30, 10, 20]), { n: 3, min: 10, median: 20, p90: 30, max: 30 });
  assert.equal(latencyStats([10, 20]).median, 15);
  const ok = parseToolResponse({ result: { content: [{ type: 'text', text: '{"a":1}' }] } });
  assert.deepEqual(ok.data, { a: 1 });
  assert.equal(ok.isError, false);
  const err = parseToolResponse({ result: { isError: true, content: [{ type: 'text', text: '{"error":{"code":"not_found"}}' }], structuredContent: { error: { code: 'not_found', reason: 'r' } } } });
  assert.equal(err.errorCode, 'not_found');
  assert.equal(parseToolResponse({ error: { code: -32602, message: 'x' } }).errorCode, 'rpc_-32602');
});

test('a refused write step never reaches the network', async () => {
  let sent = 0;
  const fetchImpl = async () => { sent++; return { status: 200, text: async () => '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}]}}' }; };
  const client = new Client({ url: 'http://x', token: 't', minIntervalMs: 0, maxCalls: 10, timeoutMs: 1000, fetchImpl });
  const sc = { id: 's', steps: [{ id: 'w', tool: 'upload_file', args: { folder: '/_os-selftest' } }, { id: 'r', tool: 'whoami' }] };
  const rep = await runScenario(sc, client, { allowWrite: false });
  assert.equal(rep.steps[0].status, 'refused');
  assert.equal(rep.steps[1].status, 'pass');
  assert.equal(sent, 1, 'only the read was sent');
  assert.equal(rep.status, 'fail', 'a refused step fails the scenario');
});

test('the call budget is enforced by the client', async () => {
  const fetchImpl = async () => ({ status: 200, text: async () => '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}]}}' });
  const client = new Client({ url: 'http://x', token: 't', minIntervalMs: 0, maxCalls: 1, timeoutMs: 1000, fetchImpl });
  const rep = await runScenario({ id: 's', steps: [{ id: 'a', tool: 'whoami' }, { id: 'b', tool: 'whoami' }] }, client, {});
  assert.equal(rep.steps[1].status, 'skipped');
  assert.equal(client.calls, 1);
});

test('every shipped read-only scenario uses only allowlisted tools; every write scenario is marked', () => {
  for (const f of readdirSync(HERE).filter((f) => f.endsWith('.json'))) {
    const sc = JSON.parse(readFileSync(join(HERE, f), 'utf8'));
    assert.ok(!sc.requiresWrite, `${f} sits with the read-only scenarios but requiresWrite`);
    for (const s of sc.steps) assert.ok(READ_ONLY_TOOLS.includes(s.tool), `${f}: ${s.tool}`);
  }
  for (const f of readdirSync(join(HERE, 'write')).filter((f) => f.endsWith('.json'))) {
    const sc = JSON.parse(readFileSync(join(HERE, 'write', f), 'utf8'));
    assert.equal(sc.requiresWrite, true, `${f} must be marked requiresWrite`);
    for (const s of sc.steps) assert.ok(!NEVER_TOOLS.includes(s.tool), `${f}: ${s.tool} is never allowed`);
  }
});
