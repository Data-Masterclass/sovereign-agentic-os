/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Tests of the expected-fail and negative-twin semantics (no cluster needed)
 * USER STORY: As the verifier I want proof that the red-first marker cannot hide a green assertion
 *             and that a twin which cannot see its hop fails the run.
 * ARCHITECTURE:
 *   - Runs each fixture in its own `node --test` child with a fresh report dir and checks the exit
 *     code and the recorded status.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runFixture(name) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-fx-'));
  const { NODE_TEST_CONTEXT, ...env } = process.env; // a nested `node --test` must not report into this run
  const r = spawnSync(process.execPath, ['--test', join(import.meta.dirname, 'fixtures', name)], { env: { ...env, E2E_REPORT_DIR: dir, E2E_IGNORE_XFAIL: '' }, encoding: 'utf8' });
  let rows = [];
  try { rows = readFileSync(join(dir, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* no result row: the file failed to load */ }
  return { code: r.status, status: rows[0]?.status, reason: rows[0]?.reason, output: `${r.stdout}${r.stderr}` };
}

test('expected-fail + red passes the run and is reported red', () => {
  const r = runFixture('xfail-red.mjs');
  assert.equal(r.code, 0);
  assert.equal(r.status, 'red');
  assert.match(r.reason, /not there yet/);
});

test('expected-fail + green FAILS the run (unexpected-green)', () => {
  const r = runFixture('xfail-green.mjs');
  assert.notEqual(r.code, 0);
  assert.equal(r.status, 'unexpected-green');
});

test('a twin that stays green with its hop disabled FAILS the run', () => {
  const r = runFixture('twin-blind.mjs');
  assert.notEqual(r.code, 0);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /stayed GREEN/);
});

test('a twin that turns red for the required reason passes', () => {
  const r = runFixture('twin-sees.mjs');
  assert.equal(r.code, 0);
  assert.equal(r.status, 'green');
});

test('a twin that turns red for the WRONG reason fails the run', () => {
  const r = runFixture('twin-wrong-reason.mjs');
  assert.notEqual(r.code, 0);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /wrong reason/);
});

test('a red twin without redReasonMust is refused at registration', () => {
  const r = runFixture('twin-no-reason.mjs');
  assert.notEqual(r.code, 0);
  assert.match(r.output, /needs meta\.redReasonMust/);
});

// ---- AT-a judgements against a fake that behaves like the documented Langfuse v2 Observations API:
// fields of a group that is not requested are ABSENT, and io comes back as raw strings.
async function fakeLangfuse(observations) {
  const { createServer } = await import('node:http');
  const groups = { core: ['id', 'traceId', 'type', 'parentObservationId'], basic: ['name', 'userId', 'isRootObservation'], io: ['input', 'output'], trace_context: ['tags'] };
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/api/public/v2/observations') { res.writeHead(404).end(); return; }
    const want = (u.searchParams.get('fields') ?? 'core,basic').split(',');
    const keep = new Set(['core', ...want].flatMap((g) => groups[g] ?? []));
    const data = observations.map((o) => Object.fromEntries(Object.entries(o).filter(([k]) => keep.has(k))));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data, meta: {} }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const obsWith = (output) => [
  { id: 'r', traceId: 't', type: 'AGENT', name: 'run', userId: 'u999', isRootObservation: true, parentObservationId: null, input: 'q', output: 'a', tags: [] },
  { id: 's', traceId: 't', type: 'TOOL', name: 'search_files', userId: 'u999', isRootObservation: false, parentObservationId: 'r', input: '{"query":"q"}', output, tags: [] },
];

async function loadAtA() {
  process.env.E2E_REPORT_DIR ??= mkdtempSync(join(tmpdir(), 'e2e-fx-'));
  return { langfuse: await import('../lib/records/langfuse.mjs'), checks: await import('../lib/checks/knowledge.mjs') };
}

test('a3.4 judgement: FAILS when the chunk is visible to u999, passes when it is not', async () => {
  const { langfuse, checks } = await loadAtA();
  for (const [output, visible] of [[JSON.stringify({ hits: [{ text: 'Notice period | 90 days', page: 2 }] }), true], [JSON.stringify({ hits: [] }), false]]) {
    const fake = await fakeLangfuse(obsWith(output));
    process.env.E2E_URL_LANGFUSE = fake.url;
    try {
      const obs = await langfuse.observations({ traceId: 't' });
      if (visible) assert.throws(() => checks.assertChunkNotVisible(obs, { answer: '90 days' }), /does not contain "90 days"/);
      else assert.doesNotThrow(() => checks.assertChunkNotVisible(obs, { answer: '90 days' }));
    } finally { fake.close(); delete process.env.E2E_URL_LANGFUSE; }
  }
});

test('a3.4 judgement cannot pass vacuously: without the io field group it throws', async () => {
  const { langfuse, checks } = await loadAtA();
  const fake = await fakeLangfuse(obsWith(JSON.stringify({ hits: [] })));
  process.env.E2E_URL_LANGFUSE = fake.url;
  try {
    const obs = await langfuse.observations({ traceId: 't', fields: 'core,basic,usage,metadata' });
    assert.throws(() => checks.assertChunkNotVisible(obs, { answer: '90 days' }), /io field group was not returned/);
  } finally { fake.close(); delete process.env.E2E_URL_LANGFUSE; }
});

test('a3.1 judgement: the answer must be rank 1 — a keyword-ranked distractor first is red', async () => {
  const { checks } = await loadAtA();
  const keyword = JSON.stringify({ hits: [{ text: 'How long before the deal team can leave the kickoff meeting 3?', page: 3 }, { text: 'Notice period | 90 days', page: 2 }] });
  const semantic = JSON.stringify({ hits: [{ text: 'Notice period | 90 days', page: 2 }, { text: 'Kickoff memo 3', page: 3 }] });
  assert.throws(() => checks.assertTopHitIsAnswer(obsWith(keyword), { answer: '90 days', page: 2 }), /rank 1 hit contains "90 days"/);
  assert.doesNotThrow(() => checks.assertTopHitIsAnswer(obsWith(semantic), { answer: '90 days', page: 2 }));
});
