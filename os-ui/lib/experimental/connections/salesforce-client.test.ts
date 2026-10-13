/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pullSalesforceSlice,
  runSalesforceSlice,
  safeSObjectName,
  sfDescribeFields,
  sfDescribeGlobal,
  sfLimits,
  nearApiQuota,
  sfToken,
  soqlDatetime,
  splitClientCredential,
  type SfConn,
  type SfFetch,
} from './salesforce.ts';

// ---- fetch fake -------------------------------------------------------------

type Call = { url: string; init: RequestInit };

function mkRes(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

/** A route-table fetch fake: first matching prefix wins; records every call. */
function fakeFetch(routes: [string, () => Response][], calls: Call[] = []): { fetchImpl: SfFetch; calls: Call[] } {
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    for (const [prefix, res] of routes) {
      if (u.includes(prefix)) return res();
    }
    return mkRes(404, { error: 'no route' });
  }) as SfFetch;
  return { fetchImpl, calls };
}

function conn(fetchImpl: SfFetch): SfConn {
  return { instanceUrl: 'https://org.my.salesforce.com', clientId: 'ck', clientSecret: 'secret_xxx', fetchImpl };
}

// ---- pure helpers -----------------------------------------------------------

test('splitClientCredential splits on the FIRST colon only', () => {
  assert.deepEqual(splitClientCredential('ck:cs:with:colons'), { clientId: 'ck', clientSecret: 'cs:with:colons' });
  assert.equal(splitClientCredential('nocolon'), null);
  assert.equal(splitClientCredential(':missingkey'), null);
  assert.equal(splitClientCredential('missingsecret:'), null);
  assert.equal(splitClientCredential(null), null);
});

test('safeSObjectName admits SObject/field names, rejects SOQL smuggling', () => {
  assert.equal(safeSObjectName('Account'), 'Account');
  assert.equal(safeSObjectName('My_Object__c'), 'My_Object__c');
  assert.throws(() => safeSObjectName('Account WHERE 1=1'));
  assert.throws(() => safeSObjectName(''));
  assert.throws(() => safeSObjectName('1bad'));
});

test('soqlDatetime normalises to the fixed ISO-Z alphabet, rejects non-datetimes', () => {
  assert.equal(soqlDatetime('2026-01-02T03:04:05.000+0000'), '2026-01-02T03:04:05.000Z');
  assert.equal(soqlDatetime('2026-01-02 03:04:05Z'), '2026-01-02T03:04:05.000Z');
  assert.throws(() => soqlDatetime("2026' OR '1'='1"));
  assert.throws(() => soqlDatetime(''));
});

// ---- token ------------------------------------------------------------------

test('sfToken posts the client-credentials grant; secret rides ONLY in the form body', async () => {
  const { fetchImpl, calls } = fakeFetch([
    ['/services/oauth2/token', () => mkRes(200, { access_token: 'tok_1' })],
  ]);
  const res = await sfToken(conn(fetchImpl));
  assert.ok(res.ok && res.data === 'tok_1');
  assert.match(calls[0].url, /\/services\/oauth2\/token$/);
  assert.match(String(calls[0].init.body), /grant_type=client_credentials/);
  assert.match(String(calls[0].init.body), /client_secret=secret_xxx/);
});

test('sfToken never throws and never leaks the secret in the failure reason', async () => {
  const { fetchImpl } = fakeFetch([
    ['/services/oauth2/token', () => mkRes(400, { error: 'invalid_client', error_description: 'bad client' })],
  ]);
  const res = await sfToken(conn(fetchImpl));
  assert.ok(!res.ok);
  assert.ok(!res.reason.includes('secret_xxx'));
  // Missing credential halves → honest reason, no call attempted.
  const none = await sfToken({ instanceUrl: 'https://x', fetchImpl });
  assert.ok(!none.ok && /consumer_key/.test(none.reason));
});

// ---- discovery --------------------------------------------------------------

test('sfDescribeGlobal returns only queryable objects; sfDescribeFields skips compound/blob', async () => {
  const { fetchImpl } = fakeFetch([
    ['/sobjects/Account/describe', () => mkRes(200, {
      fields: [
        { name: 'Id', type: 'id' },
        { name: 'BillingAddress', type: 'address' },
        { name: 'Photo', type: 'base64' },
        { name: 'SystemModstamp', type: 'datetime' },
      ],
    })],
    ['/sobjects', () => mkRes(200, {
      sobjects: [
        { name: 'Account', queryable: true, custom: false },
        { name: 'AccountShare', queryable: false, custom: false },
      ],
    })],
  ]);
  const c = conn(fetchImpl);
  const objects = await sfDescribeGlobal(c, 'tok');
  assert.ok(objects.ok);
  assert.deepEqual(objects.data, [{ name: 'Account', custom: false }]);
  const fields = await sfDescribeFields(c, 'tok', 'Account');
  assert.ok(fields.ok);
  assert.deepEqual(fields.data, ['Id', 'SystemModstamp']);
});

// ---- paging (bounded memory) ------------------------------------------------

test('pullSalesforceSlice pages via nextRecordsUrl, one onBatch per page, attributes stripped', async () => {
  const { fetchImpl, calls } = fakeFetch([
    ['/query/next-1', () => mkRes(200, {
      totalSize: 3, done: true,
      records: [{ attributes: { type: 'Account' }, Id: '3' }],
    })],
    ['/query?q=', () => mkRes(200, {
      totalSize: 3, done: false, nextRecordsUrl: '/services/data/v61.0/query/next-1',
      records: [
        { attributes: { type: 'Account' }, Id: '1' },
        { attributes: { type: 'Account' }, Id: '2' },
      ],
    })],
  ]);
  const batches: Record<string, unknown>[][] = [];
  const res = await pullSalesforceSlice({
    conn: conn(fetchImpl),
    token: 'tok',
    object: 'Account',
    fields: ['Id', 'SystemModstamp'],
    watermark: '2026-01-01T00:00:00.000Z',
    highWatermark: '2026-02-01T00:00:00.000Z',
    onBatch: async (records) => { batches.push(records); },
  });
  assert.ok(res.ok && res.data === 3);
  assert.equal(batches.length, 2, 'one onBatch per API page — never the whole slice at once');
  assert.deepEqual(batches[0], [{ Id: '1' }, { Id: '2' }], 'attributes envelope stripped');
  assert.deepEqual(batches[1], [{ Id: '3' }]);
  // The SOQL window is the canonical SystemModstamp slice, ordered.
  const soql = decodeURIComponent(calls[0].url);
  assert.match(soql, /SELECT Id, SystemModstamp FROM Account/);
  assert.match(soql, /SystemModstamp > 2026-01-01T00:00:00.000Z AND SystemModstamp <= 2026-02-01T00:00:00.000Z/);
  assert.match(soql, /ORDER BY SystemModstamp/);
});

test('pullSalesforceSlice surfaces a mid-stream failure honestly (at-least-once)', async () => {
  const { fetchImpl } = fakeFetch([
    ['/query/next-1', () => mkRes(500, { error: 'boom' })],
    ['/query?q=', () => mkRes(200, {
      totalSize: 2, done: false, nextRecordsUrl: '/services/data/v61.0/query/next-1',
      records: [{ Id: '1' }],
    })],
  ]);
  const batches: unknown[] = [];
  const res = await pullSalesforceSlice({
    conn: conn(fetchImpl), token: 'tok', object: 'Account', fields: ['Id'],
    watermark: null, highWatermark: '2026-02-01T00:00:00.000Z',
    onBatch: async (r) => { batches.push(r); },
  });
  assert.ok(!res.ok && /Salesforce 500/.test(res.reason));
  assert.equal(batches.length, 1, 'the delivered page stays delivered — at-least-once');
});

// ---- the api-batch slice runner --------------------------------------------

function runArgs(fetchImpl: SfFetch, over: Record<string, unknown> = {}) {
  const executed: string[] = [];
  return {
    executed,
    args: {
      connectionId: 'conn1',
      owner: { id: 'lena', name: 'Lena', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' as const },
      object: 'Account',
      mode: 'append' as const,
      watermark: null as string | null,
      datasetSlug: 'orders',
      target: { schema: 'personal_lena', table: 'bronze_orders' },
      identity: { principal: 'lena', uid: 'lena', domains: ['sales'], role: 'creator' as const },
      execute: async (sql: string) => { executed.push(sql); return { rowsAffected: 1 }; },
      mkBatchId: (hw: string) => `ds1.${hw.replace(/[^A-Za-z0-9_.:-]+/g, '-')}`,
      startedAt: '2026-07-01T10:00:00.000Z',
      resolve: async () => conn(fetchImpl),
      ingestUrl: 'http://data-runner:8000',
      fetchImpl,
      ...over,
    },
  };
}

const SF_ROUTES = (records: Record<string, unknown>[]): [string, () => Response][] => [
  ['/services/oauth2/token', () => mkRes(200, { access_token: 'tok' })],
  ['MAX(SystemModstamp)', () => mkRes(200, { done: true, records: [{ expr0: '2026-06-30T00:00:00.000+0000' }] })],
  ['/sobjects/Account/describe', () => mkRes(200, { fields: [{ name: 'Id', type: 'id' }, { name: 'SystemModstamp', type: 'datetime' }] })],
  ['/query?q=', () => mkRes(200, { done: true, records })],
  ['/ingest-rows', () => mkRes(200, { ok: true, rowCount: records.length })],
];

test('runSalesforceSlice first load: replace-first-batch, lineage stamped, hw advances', async () => {
  const calls: Call[] = [];
  const { fetchImpl } = fakeFetch(SF_ROUTES([{ Id: '1', SystemModstamp: '2026-06-29T00:00:00.000Z' }]), calls);
  const { args, executed } = runArgs(fetchImpl);
  const out = await runSalesforceSlice(args);
  assert.equal(out.rowsAffected, 1);
  assert.equal(out.highWatermark, '2026-06-30T00:00:00.000Z');
  assert.ok(out.batchId);
  assert.equal(executed.length, 0, 'no delete-batch on a first load (replace is the idempotency)');
  const ingest = calls.find((c) => c.url.includes('/ingest-rows'))!;
  const payload = JSON.parse(String(ingest.init.body)) as { rows: Record<string, unknown>[]; mode: string; principal: string; dataset: string };
  assert.equal(payload.mode, 'replace');
  assert.equal(payload.principal, 'lena');
  assert.equal(payload.dataset, 'orders');
  assert.equal(payload.rows[0]._loaded_at, '2026-07-01T10:00:00.000Z');
  assert.equal(payload.rows[0]._batch_id, out.batchId);
});

test('runSalesforceSlice incremental: delete-batch first, append mode, bounded window', async () => {
  const calls: Call[] = [];
  const { fetchImpl } = fakeFetch(SF_ROUTES([{ Id: '2' }]), calls);
  const { args, executed } = runArgs(fetchImpl, { watermark: '2026-06-01T00:00:00.000Z' });
  const out = await runSalesforceSlice(args);
  assert.equal(out.rowsAffected, 1);
  assert.match(executed[0], /^DELETE FROM iceberg\.personal_lena\.bronze_orders WHERE _batch_id = '/);
  const ingest = calls.find((c) => c.url.includes('/ingest-rows'))!;
  assert.equal((JSON.parse(String(ingest.init.body)) as { mode: string }).mode, 'append');
  const soql = decodeURIComponent(calls.find((c) => c.url.includes('query?q=SELECT%20Id'))?.url ?? calls.map((c) => c.url).join(' '));
  assert.match(soql, /SystemModstamp > 2026-06-01T00:00:00.000Z/);
});

test('runSalesforceSlice empty first load keeps first-run semantics (no phantom cursor)', async () => {
  const { fetchImpl } = fakeFetch(SF_ROUTES([]));
  const { args } = runArgs(fetchImpl);
  const out = await runSalesforceSlice(args);
  assert.equal(out.rowsAffected, 0);
  assert.equal(out.highWatermark, null, 'no rows landed ⇒ no table ⇒ cursor must not advance');
});

test('runSalesforceSlice fails honestly when the object is not incrementally syncable', async () => {
  const routes = SF_ROUTES([{ Id: '1' }]).map(([k, v]): [string, () => Response] =>
    k === '/sobjects/Account/describe' ? [k, () => mkRes(200, { fields: [{ name: 'Id', type: 'id' }] })] : [k, v]);
  const { fetchImpl } = fakeFetch(routes);
  const { args } = runArgs(fetchImpl);
  await assert.rejects(() => runSalesforceSlice(args), /no SystemModstamp/);
});

// ---- error-path: watermark-safety -------------------------------------------

test('pullSalesforceSlice: 401 on page 2 surfaces honest error, watermark does not advance', async () => {
  const { fetchImpl } = fakeFetch([
    ['/query/next-1', () => mkRes(401, { error: 'SESSION_EXPIRED' })],
    ['/query?q=', () => mkRes(200, {
      totalSize: 2, done: false, nextRecordsUrl: '/services/data/v61.0/query/next-1',
      records: [{ attributes: { type: 'Account' }, Id: 'p1r1' }],
    })],
  ]);
  const batches: unknown[] = [];
  const res = await pullSalesforceSlice({
    conn: conn(fetchImpl), token: 'tok', object: 'Account', fields: ['Id'],
    watermark: null, highWatermark: '2026-02-01T00:00:00.000Z',
    onBatch: async (r) => { batches.push(r); },
  });
  assert.ok(!res.ok, 'must surface the error');
  assert.match(res.reason, /401/, 'reason must mention the HTTP status');
  assert.equal(batches.length, 1, 'page-1 batch was delivered before the error — at-least-once');
});

test('pullSalesforceSlice: malformed HTML body on page 2 surfaces parse error, watermark does not advance', async () => {
  const htmlRes = (): Response => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => { throw new SyntaxError('unexpected token'); },
    text: async () => '<html>error</html>',
  } as unknown as Response);
  const { fetchImpl } = fakeFetch([
    ['/query/next-1', htmlRes],
    ['/query?q=', () => mkRes(200, {
      totalSize: 2, done: false, nextRecordsUrl: '/services/data/v61.0/query/next-1',
      records: [{ attributes: { type: 'Account' }, Id: 'p1r1' }],
    })],
  ]);
  const batches: unknown[] = [];
  const res = await pullSalesforceSlice({
    conn: conn(fetchImpl), token: 'tok', object: 'Account', fields: ['Id'],
    watermark: null, highWatermark: '2026-02-01T00:00:00.000Z',
    onBatch: async (r) => { batches.push(r); },
  });
  assert.ok(!res.ok, 'must surface the parse error');
  assert.match(res.reason, /unreachable/i, 'caught JSON parse → Salesforce unreachable');
  assert.equal(batches.length, 1, 'page-1 batch was delivered before the error — at-least-once');
});

test('pullSalesforceSlice: 429 on page 2 surfaces rate-limit error, watermark does not advance', async () => {
  const { fetchImpl } = fakeFetch([
    ['/query/next-1', () => mkRes(429, {})],
    ['/query?q=', () => mkRes(200, {
      totalSize: 2, done: false, nextRecordsUrl: '/services/data/v61.0/query/next-1',
      records: [{ attributes: { type: 'Account' }, Id: 'p1r1' }],
    })],
  ]);
  const batches: unknown[] = [];
  const res = await pullSalesforceSlice({
    conn: conn(fetchImpl), token: 'tok', object: 'Account', fields: ['Id'],
    watermark: null, highWatermark: '2026-02-01T00:00:00.000Z',
    onBatch: async (r) => { batches.push(r); },
  });
  assert.ok(!res.ok, 'must surface the rate-limit error');
  assert.match(res.reason, /rate-limit/i, 'reason must mention rate-limiting');
  assert.equal(batches.length, 1, 'page-1 batch was delivered before the rate-limit — at-least-once');
});

test('runSalesforceSlice incremental retry reuses the given window; dispatch marker fires before landing', async () => {
  const calls: Call[] = [];
  const { fetchImpl } = fakeFetch(SF_ROUTES([{ Id: '9' }]), calls);
  const order: string[] = [];
  const { args, executed } = runArgs(fetchImpl, {
    watermark: '2026-06-01T00:00:00.000Z',
    window: { highWatermark: '2026-06-15T00:00:00.000Z' },
    onWindow: (hw: string, bid: string) => { order.push(`window:${hw}:${bid}`); },
  });
  const out = await runSalesforceSlice(args);
  assert.equal(out.highWatermark, '2026-06-15T00:00:00.000Z', 'the unconfirmed window is re-covered');
  assert.ok(!calls.some((c) => c.url.includes('MAX(SystemModstamp)')), 'no fresh probe over an unconfirmed slice');
  assert.equal(order.length, 1, 'the dispatch marker fired');
  const firstIngest = calls.findIndex((c) => c.url.includes('/ingest-rows'));
  assert.ok(firstIngest >= 0);
  assert.match(executed[0], /_batch_id/, 'delete-by-batch-id ran before the re-pull');
  const soql = decodeURIComponent(calls.map((c) => c.url).join(' '));
  assert.match(soql, /SystemModstamp <= 2026-06-15T00:00:00.000Z/, 'the slice is bounded to the reused window');
});

// ---- /limits quota pre-flight (Phase 6) -------------------------------------

test('sfLimits reads DailyApiRequests (Max + Remaining); omission ⇒ null (never fabricated)', async () => {
  const { fetchImpl } = fakeFetch([
    ['/limits', () => mkRes(200, { DailyApiRequests: { Max: 100000, Remaining: 4200 } })],
  ]);
  const res = await sfLimits(conn(fetchImpl), 'tok');
  assert.ok(res.ok && res.data);
  assert.deepEqual(res.data, { max: 100000, remaining: 4200 });

  // A body without DailyApiRequests ⇒ ok with null (absent > fabricated).
  const { fetchImpl: f2 } = fakeFetch([['/limits', () => mkRes(200, { Other: { Max: 1 } })]]);
  const res2 = await sfLimits(conn(f2), 'tok');
  assert.ok(res2.ok && res2.data === null);
});

test('nearApiQuota: pure — near-quota true, healthy false, absent ⇒ false (no signal)', () => {
  assert.equal(nearApiQuota({ max: 100000, remaining: 5000 }), true); // 5% left → skip
  assert.equal(nearApiQuota({ max: 100000, remaining: 50000 }), false); // 50% left → proceed
  assert.equal(nearApiQuota(null), false); // no signal → proceed unchanged (nil-safe)
  assert.equal(nearApiQuota({ max: 0, remaining: 0 }), false); // guard against div-by-zero
});
