/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The DQ alert claim — only ONE pod sends a given alert (compare-and-set on the shared store)
 * USER STORY: As a dataset owner I want one notification per failing check execution even when os-ui
 *             runs several replicas, each with its own in-process state and its own 5-minute timer.
 * ARCHITECTURE: `claimDqAlert` is an OpenSearch create-only write (`_create`: 201 for the first caller,
 *   409 for everyone after). By default this test serves that documented contract from a tiny local HTTP
 *   server; set DQ_TEST_OPENSEARCH_URL to run the SAME assertions against a real OpenSearch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

const REAL = process.env.DQ_TEST_OPENSEARCH_URL;
const seen = new Set<string>();
let server: http.Server | null = null;

before(async () => {
  if (REAL) { process.env.OPENSEARCH_URL = REAL; return; }
  server = http.createServer((req, res) => {
    const m = /^\/([^/]+)\/_create\/([^?]+)/.exec(req.url ?? '');
    req.resume();
    req.on('end', () => {
      if (req.method !== 'PUT' || !m) { res.writeHead(404).end('{}'); return; }
      const key = `${m[1]}/${m[2]}`;
      if (seen.has(key)) { res.writeHead(409, { 'content-type': 'application/json' }).end('{"error":{"type":"version_conflict_engine_exception"}}'); return; }
      seen.add(key);
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"result":"created"}');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  process.env.OPENSEARCH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { if (server) await new Promise((r) => server!.close(r)); });

const run = () => `2026-11-22T06:00:00.000Z#${randomUUID()}`;

test('two pods claiming the same dataset, rule and execution at once: exactly one wins', async () => {
  const { claimDqAlert } = await import('@tabs/data/lib/dq-alert-state');
  const k = { datasetId: 'ds_1', rule: 'not_null(x)', ranAt: run() };
  const got = (await Promise.all([claimDqAlert(k), claimDqAlert(k), claimDqAlert(k)])).sort();
  assert.deepEqual(got, ['lost', 'lost', 'won']);
});

test('a different rule, dataset or execution is a different claim (negative twin)', async () => {
  const { claimDqAlert } = await import('@tabs/data/lib/dq-alert-state');
  const ranAt = run();
  assert.equal(await claimDqAlert({ datasetId: 'ds_1', rule: 'a', ranAt }), 'won');
  assert.equal(await claimDqAlert({ datasetId: 'ds_1', rule: 'b', ranAt }), 'won');
  assert.equal(await claimDqAlert({ datasetId: 'ds_2', rule: 'a', ranAt }), 'won');
  assert.equal(await claimDqAlert({ datasetId: 'ds_1', rule: 'a', ranAt: run() }), 'won');
  assert.equal(await claimDqAlert({ datasetId: 'ds_1', rule: 'a', ranAt }), 'lost');
});

test('a store that cannot be reached is "unreachable", never a win', { skip: !!REAL }, async () => {
  const { claimDqAlert } = await import('@tabs/data/lib/dq-alert-state');
  const prev = process.env.OPENSEARCH_URL;
  process.env.OPENSEARCH_URL = 'http://127.0.0.1:1';
  try {
    assert.equal(await claimDqAlert({ datasetId: 'ds_1', rule: 'a', ranAt: run() }), 'unreachable');
  } finally {
    process.env.OPENSEARCH_URL = prev;
  }
});
