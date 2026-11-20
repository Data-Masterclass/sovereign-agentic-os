/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
// The one OpenSearch client: URL from OPENSEARCH_URL only, auth header only when configured,
// null on a transport failure, and the initContainer's wait loop names a 401 plainly. A real
// local HTTP server stands in for OpenSearch's REST surface (no fetch mock).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { opensearchAuthHeaders, opensearchBaseUrl, opensearchFetch, opensearchRequestUrl, opensearchTry, waitForOpenSearch } from './client.ts';

const seen: IncomingMessage[] = [];
let healthStatus = 401;
const server = createServer((req, res) => {
  seen.push(req);
  if (req.url?.startsWith('/_cluster/health')) {
    res.writeHead(healthStatus, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
after(() => server.close());

test('base URL comes from OPENSEARCH_URL (trailing slash trimmed) with the in-cluster default', () => {
  const prev = process.env.OPENSEARCH_URL;
  delete process.env.OPENSEARCH_URL;
  assert.equal(opensearchBaseUrl(), 'http://opensearch:9200');
  process.env.OPENSEARCH_URL = url;
  assert.equal(opensearchBaseUrl(), url.slice(0, -1));
  assert.equal(opensearchRequestUrl('files/_search'), `${url}files/_search`);
  assert.equal(opensearchRequestUrl('/files/_search'), `${url}files/_search`);
  if (prev === undefined) delete process.env.OPENSEARCH_URL;
  else process.env.OPENSEARCH_URL = prev;
});

test('no credentials configured -> no authorization header is sent', async () => {
  process.env.OPENSEARCH_URL = url;
  delete process.env.OPENSEARCH_USERNAME;
  delete process.env.OPENSEARCH_PASSWORD;
  assert.deepEqual(opensearchAuthHeaders(), {});
  seen.length = 0;
  const r = await opensearchFetch('/files/_search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers['content-type'], 'application/json');
});

test('credentials configured -> every call carries basic auth (the one place WP-22 sets them)', async () => {
  process.env.OPENSEARCH_URL = url;
  process.env.OPENSEARCH_USERNAME = 'soa_app';
  process.env.OPENSEARCH_PASSWORD = 'test-only';
  seen.length = 0;
  await opensearchFetch('/knowledge/_search', { method: 'POST', body: '{}' });
  await opensearchTry('/os-users/_doc/1');
  assert.equal(seen.length, 2);
  for (const req of seen) assert.equal(req.headers.authorization, `Basic ${Buffer.from('soa_app:test-only').toString('base64')}`);
  delete process.env.OPENSEARCH_USERNAME;
  delete process.env.OPENSEARCH_PASSWORD;
});

test('opensearchTry returns null when OpenSearch is unreachable; opensearchFetch throws', async () => {
  process.env.OPENSEARCH_URL = 'http://127.0.0.1:1';
  assert.equal(await opensearchTry('/x', { timeoutMs: 1000 }), null);
  await assert.rejects(opensearchFetch('/x', { timeoutMs: 1000 }));
  process.env.OPENSEARCH_URL = url;
});

test('waitForOpenSearch names a 401 as a credentials problem, then succeeds on 200', async () => {
  process.env.OPENSEARCH_URL = url;
  const logs: string[] = [];
  healthStatus = 401;
  const flip = setTimeout(() => { healthStatus = 200; }, 120);
  const ok = await waitForOpenSearch({ deadlineMs: 5000, intervalMs: 50, log: (s) => logs.push(s) });
  clearTimeout(flip);
  assert.equal(ok, true);
  assert.match(logs[0], /^401 from OpenSearch: credentials missing or wrong/);
  assert.equal(logs.at(-1), 'opensearch ready');
});

test('waitForOpenSearch gives up (false) after the deadline', async () => {
  process.env.OPENSEARCH_URL = 'http://127.0.0.1:1';
  const ok = await waitForOpenSearch({ deadlineMs: 100, intervalMs: 50, log: () => {} });
  assert.equal(ok, false);
  process.env.OPENSEARCH_URL = url;
});
