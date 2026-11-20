// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// client.int.test (WP-13; design 06 §5.3, 10 competing-code 21): does npm `trino-client`
// (https://github.com/trinodb/trino-js-client, Apache-2.0, pinned in package.json) send
// `Authorization`, `X-Trino-User`, `X-Trino-Source` and client tags, and does Trino take them?
//
//   (cd tests/lakehouse && npm ci) && bash tests/lakehouse/up.sh
//   node --test tests/lakehouse/client.int.test.mjs
//
// Part 1 captures the client's raw requests on a local HTTP listener (headers on the wire).
// Part 2 runs the same client against the chart's Trino and reads Trino's own record of the
// session (QueryInfo + system.runtime.queries). The result is recorded in
// components/trino/UPSTREAM.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Trino, BasicAuth } from 'trino-client';
import { TRINO, info, queries } from './lib.mjs';

const ROUTE = { source: 'os-ui/sales/data-query', tags: 'os-ui,domain=sales,surface=data-query' };

function capture() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    // A finished query: one row, no nextUri.
    res.end(JSON.stringify({ id: 'q1', columns: [{ name: 'x', type: 'integer' }], data: [[1]], stats: { state: 'FINISHED' } }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function drain(iter) {
  const rows = [];
  let id;
  for await (const r of iter) { id = r.id; if (r.error) throw new Error(r.error.message); rows.push(...(r.data ?? [])); }
  return { id, rows };
}

test('on the wire: Authorization (service user), X-Trino-User (the uid), X-Trino-Source, client tags', async () => {
  const { srv, seen, url } = await capture();
  try {
    const t = Trino.create({ server: url, auth: new BasicAuth('svc-os-ui', 's3cret'), source: ROUTE.source, extraHeaders: { 'X-Trino-Client-Tags': ROUTE.tags } });
    await drain(await t.query({ query: 'SELECT 1', user: 'u-alice' }));
    const post = seen.find((r) => r.method === 'POST');
    assert.ok(post, 'no POST /v1/statement');
    assert.equal(post.url, '/v1/statement');
    assert.equal(post.headers.authorization, `Basic ${Buffer.from('svc-os-ui:s3cret').toString('base64')}`);
    assert.equal(post.headers['x-trino-user'], 'u-alice', 'the per-query user overrides the auth user');
    assert.equal(post.headers['x-trino-source'], ROUTE.source);
    assert.equal(post.headers['x-trino-client-tags'], ROUTE.tags);
  } finally {
    srv.close();
  }
});

test('on Trino: the session user, source and client tags are what the client sent; it lands in its own group', async () => {
  const t = Trino.create({ server: TRINO, source: ROUTE.source, extraHeaders: { 'X-Trino-Client-Tags': ROUTE.tags } });
  const { id, rows } = await drain(await t.query({ query: 'SELECT 1', user: 'u-alice' }));
  assert.deepEqual(rows, [[1]]);
  const qi = await info(id);
  assert.equal(qi.session.user, 'u-alice');
  assert.equal(qi.session.source, ROUTE.source);
  assert.deepEqual([...qi.session.clientTags].sort(), ROUTE.tags.split(',').sort());
  assert.equal((await queries([id]))[id].rg, 'global.domains.sales.u-alice');
});

test('NEGATIVE TWIN: without `source` the client sends its own default, which lands in global.other', async () => {
  const t = Trino.create({ server: TRINO });
  const { id } = await drain(await t.query({ query: 'SELECT 1', user: 'u-alice' }));
  const row = (await queries([id]))[id];
  assert.equal(row.source, 'trino-js-client');
  assert.equal(row.rg, 'global.other');
});

test('shared client state: a session set by one response is sent on the NEXT query of the same Client', async () => {
  // Recorded for the client choice (UPSTREAM.md): Client.request() writes X-Trino-Set-Session
  // back onto the shared client config, so one Client must never serve two callers.
  const t = Trino.create({ server: TRINO, source: ROUTE.source });
  await drain(await t.query({ query: "SET SESSION query_max_run_time = '30s'", user: 'u-alice' }));
  const { id } = await drain(await t.query({ query: 'SELECT 1', user: 'u-bob' }));
  assert.equal((await info(id)).session.systemProperties.query_max_run_time, '30s',
    "u-bob's query carried u-alice's session property");
});
