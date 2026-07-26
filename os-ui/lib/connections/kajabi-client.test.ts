/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenKajabiRecord,
  kajabiDatetime,
  kjProbeMaxCursor,
  kjToken,
  pullKajabiSlice,
  runKajabiSlice,
  safeKajabiResource,
  splitKajabiCredential,
  type KajabiConn,
  type KjFetch,
} from './kajabi.ts';
import { KAJABI_RESOURCES, kajabiCursorField } from './kajabi-resources.ts';

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

/** A route-table fetch fake: first matching predicate wins; records every call. */
function fakeFetch(routes: [string | ((u: string) => boolean), () => Response][], calls: Call[] = []): { fetchImpl: KjFetch; calls: Call[] } {
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    for (const [match, res] of routes) {
      if (typeof match === 'string' ? u.includes(match) : match(u)) return res();
    }
    return mkRes(404, { error: 'no route' });
  }) as KjFetch;
  return { fetchImpl, calls };
}

function conn(fetchImpl: KjFetch): KajabiConn {
  return { baseUrl: 'https://api.kajabi.com', clientId: 'cid', clientSecret: 'secret_xxx', fetchImpl };
}

const rec = (id: string, attrs: Record<string, unknown>, rels: Record<string, unknown> = {}) =>
  ({ id, type: 'purchases', attributes: attrs, relationships: rels }) as never;

// ---- pure helpers -----------------------------------------------------------

test('splitKajabiCredential splits on the FIRST colon only', () => {
  assert.deepEqual(splitKajabiCredential('cid:cs:with:colons'), { clientId: 'cid', clientSecret: 'cs:with:colons' });
  assert.equal(splitKajabiCredential('nocolon'), null);
  assert.equal(splitKajabiCredential(':missingid'), null);
  assert.equal(splitKajabiCredential('missingsecret:'), null);
  assert.equal(splitKajabiCredential(null), null);
});

test('safeKajabiResource admits only curated resources (nothing user-typed reaches a URL)', () => {
  assert.equal(safeKajabiResource('purchases').path, '/v1/purchases');
  assert.equal(safeKajabiResource('  Contacts ').name, 'contacts');
  assert.throws(() => safeKajabiResource('purchases?x=1'));
  assert.throws(() => safeKajabiResource('unknown_thing'));
  assert.throws(() => safeKajabiResource(''));
});

test('kajabiDatetime normalises to the fixed ISO-Z alphabet, rejects non-datetimes', () => {
  assert.equal(kajabiDatetime('2026-01-02T03:04:05.000+00:00'), '2026-01-02T03:04:05.000Z');
  assert.equal(kajabiDatetime('2026-01-02 03:04:05Z'), '2026-01-02T03:04:05.000Z');
  assert.throws(() => kajabiDatetime("2026' OR '1'='1"));
  assert.throws(() => kajabiDatetime(''));
});

test('the curated resource map is honest: only purchases has an update cursor', () => {
  assert.equal(kajabiCursorField('purchases'), 'updated_at');
  assert.equal(kajabiCursorField('contacts'), 'created_at');
  assert.equal(kajabiCursorField('offers'), null);
  assert.equal(kajabiCursorField('transactions'), null);
  assert.equal(kajabiCursorField('nope'), null);
  // Every resource states its honesty note.
  for (const r of KAJABI_RESOURCES) assert.ok(r.note.length > 10, `${r.name} has a note`);
});

// ---- JSON:API flattening ----------------------------------------------------

test('flattenKajabiRecord: id + attributes flat, nested stringified, to-one rel → <name>_id, to-many skipped', () => {
  const row = flattenKajabiRecord(rec('42', {
    amount_in_cents: 4900,
    currency: 'EUR',
    opt_in: true,
    metadata: { a: 1 },
    tags_list: ['x'],
    updated_at: '2026-06-01T00:00:00Z',
  }, {
    customer: { data: { id: '7', type: 'customers' } },
    site: { data: null },
    transactions: { data: [{ id: '1' }, { id: '2' }] }, // to-many: skipped
  }));
  assert.deepEqual(row, {
    id: '42',
    amount_in_cents: 4900,
    currency: 'EUR',
    opt_in: true,
    metadata: '{"a":1}',
    tags_list: '["x"]',
    updated_at: '2026-06-01T00:00:00Z',
    customer_id: '7',
    site_id: null,
  });
});

test('flattenKajabiRecord: a relationship never clobbers a same-named attribute column', () => {
  const row = flattenKajabiRecord(rec('1', { site_id: 'attr-wins' }, { site: { data: { id: 'rel' } } }));
  assert.equal(row.site_id, 'attr-wins');
});

// ---- token ------------------------------------------------------------------

test('kjToken posts the client-credentials grant; secret rides ONLY in the form body', async () => {
  const { fetchImpl, calls } = fakeFetch([
    ['/v1/oauth/token', () => mkRes(200, { access_token: 'tok_1', token_type: 'Bearer' })],
  ]);
  const res = await kjToken(conn(fetchImpl));
  assert.ok(res.ok && res.data === 'tok_1');
  assert.match(calls[0].url, /\/v1\/oauth\/token$/);
  assert.match(String(calls[0].init.body), /grant_type=client_credentials/);
  assert.match(String(calls[0].init.body), /client_secret=secret_xxx/);
});

test('kjToken never throws and never leaks the secret in the failure reason', async () => {
  const { fetchImpl } = fakeFetch([
    ['/v1/oauth/token', () => mkRes(401, { error: 'invalid_client', error_description: 'bad client' })],
  ]);
  const res = await kjToken(conn(fetchImpl));
  assert.ok(!res.ok);
  assert.ok(!res.reason.includes('secret_xxx'));
  // Missing credential halves → honest reason, no call attempted.
  const none = await kjToken({ baseUrl: 'https://x', fetchImpl });
  assert.ok(!none.ok && /client_id/.test(none.reason));
});

// ---- probe ------------------------------------------------------------------

test('kjProbeMaxCursor asks for one row sorted desc; empty ⇒ null; missing attr ⇒ honest failure', async () => {
  const { fetchImpl, calls } = fakeFetch([
    ['/v1/purchases', () => mkRes(200, { data: [rec('1', { updated_at: '2026-06-30T00:00:00Z' })] })],
  ]);
  const c = conn(fetchImpl);
  const probe = await kjProbeMaxCursor(c, 'tok', '/v1/purchases', 'updated_at');
  assert.ok(probe.ok && probe.data === '2026-06-30T00:00:00Z');
  const q = decodeURIComponent(calls[0].url);
  assert.match(q, /sort=-updated_at/);
  assert.match(q, /page\[size\]=1/);

  const empty = fakeFetch([['/v1/purchases', () => mkRes(200, { data: [] })]]);
  const p2 = await kjProbeMaxCursor(conn(empty.fetchImpl), 'tok', '/v1/purchases', 'updated_at');
  assert.ok(p2.ok && p2.data === null);

  const noAttr = fakeFetch([['/v1/purchases', () => mkRes(200, { data: [rec('1', {})] })]]);
  const p3 = await kjProbeMaxCursor(conn(noAttr.fetchImpl), 'tok', '/v1/purchases', 'updated_at');
  assert.ok(!p3.ok && /use full-refresh/.test(p3.reason));
});

// ---- paging (stop-early, bounded memory) ------------------------------------

test('pullKajabiSlice pages desc via links.next, stops early at the watermark, windows to the hw', async () => {
  const page1 = {
    data: [
      rec('9', { updated_at: '2026-07-05T00:00:00Z' }), // > hw: created during the pull — skipped
      rec('3', { updated_at: '2026-06-20T00:00:00Z' }),
      rec('2', { updated_at: '2026-06-10T00:00:00Z' }),
    ],
    links: { next: 'https://api.kajabi.com/v1/purchases?page[number]=2' },
  };
  const page2 = {
    data: [
      rec('1', { updated_at: '2026-06-01T00:00:00Z' }), // == watermark ⇒ STOP (rest is older)
      rec('0', { updated_at: '2026-05-01T00:00:00Z' }),
    ],
    links: { next: 'https://api.kajabi.com/v1/purchases?page[number]=3' },
  };
  const { fetchImpl, calls } = fakeFetch([
    [(u) => u.includes('page%5Bnumber%5D=2'), () => mkRes(200, page2)],
    ['/v1/purchases', () => mkRes(200, page1)],
  ]);
  const batches: Record<string, unknown>[][] = [];
  const res = await pullKajabiSlice({
    conn: conn(fetchImpl),
    token: 'tok',
    resource: 'purchases',
    cursorField: 'updated_at',
    watermark: '2026-06-01T00:00:00.000Z',
    highWatermark: '2026-06-30T00:00:00.000Z',
    onBatch: async (rows) => { batches.push(rows); },
  });
  assert.ok(res.ok && res.data === 2, JSON.stringify(res));
  assert.equal(batches.length, 1, 'page 2 contributes nothing inside the window');
  assert.deepEqual(batches[0].map((r) => r.id), ['3', '2'], 'window (wm, hw] only, flattened');
  assert.equal(calls.length, 2, 'stopped after the watermark hit — page 3 never fetched');
  const q = decodeURIComponent(calls[0].url);
  assert.match(q, /sort=-updated_at/);
  assert.match(q, /page\[size\]=100/);
});

test('pullKajabiSlice cursorless full pull walks every page and flattens', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [(u) => u.includes('page%5Bnumber%5D=2'), () => mkRes(200, { data: [rec('b', { name: 'B' })] })],
    ['/v1/offers', () => mkRes(200, {
      data: [rec('a', { name: 'A' })],
      links: { next: 'https://api.kajabi.com/v1/offers?page[number]=2' },
    })],
  ]);
  const batches: Record<string, unknown>[][] = [];
  const res = await pullKajabiSlice({
    conn: conn(fetchImpl), token: 'tok', resource: 'offers', cursorField: null,
    watermark: null, highWatermark: null,
    onBatch: async (rows) => { batches.push(rows); },
  });
  assert.ok(res.ok && res.data === 2);
  assert.equal(batches.length, 2, 'one onBatch per API page — never the whole slice at once');
  assert.ok(!decodeURIComponent(calls[0].url).includes('sort='), 'no sort on a cursorless pull');
});

test('pullKajabiSlice surfaces a mid-stream failure honestly (at-least-once)', async () => {
  const { fetchImpl } = fakeFetch([
    [(u) => u.includes('page%5Bnumber%5D=2'), () => mkRes(500, { error: 'boom' })],
    ['/v1/purchases', () => mkRes(200, {
      data: [rec('2', { updated_at: '2026-06-10T00:00:00Z' })],
      links: { next: 'https://api.kajabi.com/v1/purchases?page[number]=2' },
    })],
  ]);
  const batches: unknown[] = [];
  const res = await pullKajabiSlice({
    conn: conn(fetchImpl), token: 'tok', resource: 'purchases', cursorField: 'updated_at',
    watermark: null, highWatermark: '2026-06-30T00:00:00.000Z',
    onBatch: async (r) => { batches.push(r); },
  });
  assert.ok(!res.ok && /Kajabi 500/.test(res.reason));
  assert.equal(batches.length, 1, 'the delivered page stays delivered — at-least-once');
});

test('pullKajabiSlice fails honestly when a row lacks the cursor attribute', async () => {
  const { fetchImpl } = fakeFetch([
    ['/v1/form_submissions', () => mkRes(200, { data: [rec('1', { email: 'x@y.z' })] })],
  ]);
  const res = await pullKajabiSlice({
    conn: conn(fetchImpl), token: 'tok', resource: 'form_submissions', cursorField: 'created_at',
    watermark: null, highWatermark: '2026-06-30T00:00:00.000Z',
    onBatch: async () => {},
  });
  assert.ok(!res.ok && /use full-refresh/.test(res.reason));
});

// ---- the api-batch slice runner --------------------------------------------

function runArgs(fetchImpl: KjFetch, over: Record<string, unknown> = {}) {
  const executed: string[] = [];
  return {
    executed,
    args: {
      connectionId: 'conn1',
      owner: { id: 'lena', name: 'Lena', domains: ['sales'], allDomains: ['sales'], activeDomain: null, role: 'creator' as const },
      resource: 'purchases',
      mode: 'append' as const,
      watermark: null as string | null,
      datasetSlug: 'purchases',
      target: { schema: 'personal_lena', table: 'bronze_purchases' },
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

/** Routes for one purchases slice: token, probe (page[size]=1), the page pull, ingest. */
const KJ_ROUTES = (records: ReturnType<typeof rec>[]): [string | ((u: string) => boolean), () => Response][] => [
  ['/v1/oauth/token', () => mkRes(200, { access_token: 'tok' })],
  [(u) => u.includes('/v1/purchases') && u.includes('page%5Bsize%5D=1&'),
    () => mkRes(200, { data: records.slice(0, 1) })],
  ['/v1/purchases', () => mkRes(200, { data: records })],
  ['/ingest-rows', () => mkRes(200, { ok: true, rowCount: records.length })],
];

const R1 = rec('1', { updated_at: '2026-06-30T00:00:00Z', amount_in_cents: 100 }, { customer: { data: { id: '7' } } });

test('runKajabiSlice first load: replace-first-batch, lineage stamped, hw advances', async () => {
  const calls: Call[] = [];
  const { fetchImpl } = fakeFetch(KJ_ROUTES([R1]), calls);
  const { args, executed } = runArgs(fetchImpl);
  const out = await runKajabiSlice(args);
  assert.equal(out.rowsAffected, 1);
  assert.equal(out.highWatermark, '2026-06-30T00:00:00.000Z');
  assert.ok(out.batchId);
  assert.equal(executed.length, 0, 'no delete-batch on a first load (replace is the idempotency)');
  const ingest = calls.find((c) => c.url.includes('/ingest-rows'))!;
  const payload = JSON.parse(String(ingest.init.body)) as { rows: Record<string, unknown>[]; mode: string; principal: string; dataset: string };
  assert.equal(payload.mode, 'replace');
  assert.equal(payload.principal, 'lena');
  assert.equal(payload.dataset, 'purchases');
  assert.equal(payload.rows[0]._loaded_at, '2026-07-01T10:00:00.000Z');
  assert.equal(payload.rows[0]._batch_id, out.batchId);
  assert.equal(payload.rows[0].customer_id, '7', 'to-one relationship flattened into the row');
});

test('runKajabiSlice incremental: delete-batch first, append mode', async () => {
  const calls: Call[] = [];
  const { fetchImpl } = fakeFetch(KJ_ROUTES([R1]), calls);
  const { args, executed } = runArgs(fetchImpl, { watermark: '2026-06-01T00:00:00.000Z' });
  const out = await runKajabiSlice(args);
  assert.equal(out.rowsAffected, 1);
  assert.match(executed[0], /^DELETE FROM iceberg\.personal_lena\.bronze_purchases WHERE _batch_id = '/);
  const ingest = calls.find((c) => c.url.includes('/ingest-rows'))!;
  assert.equal((JSON.parse(String(ingest.init.body)) as { mode: string }).mode, 'append');
});

test('runKajabiSlice empty first load keeps first-run semantics (no phantom cursor)', async () => {
  const { fetchImpl } = fakeFetch(KJ_ROUTES([]));
  const { args } = runArgs(fetchImpl);
  const out = await runKajabiSlice(args);
  assert.equal(out.rowsAffected, 0);
  assert.equal(out.highWatermark, null, 'no rows landed ⇒ no table ⇒ cursor must not advance');
});

test('runKajabiSlice refuses incremental mode on a resource with no documented cursor', async () => {
  const { fetchImpl } = fakeFetch([['/v1/oauth/token', () => mkRes(200, { access_token: 'tok' })]]);
  const { args } = runArgs(fetchImpl, { resource: 'offers', watermark: '2026-06-01T00:00:00.000Z' });
  await assert.rejects(() => runKajabiSlice(args), /no timestamp cursor/);
});

test('runKajabiSlice cursorless full refresh: replace stream, null hw, batch id from run start', async () => {
  const calls: Call[] = [];
  const { fetchImpl } = fakeFetch([
    ['/v1/oauth/token', () => mkRes(200, { access_token: 'tok' })],
    ['/v1/offers', () => mkRes(200, { data: [rec('a', { name: 'A' })] })],
    ['/ingest-rows', () => mkRes(200, { ok: true })],
  ], calls);
  const { args, executed } = runArgs(fetchImpl, { resource: 'offers', mode: 'full-refresh' as const });
  const out = await runKajabiSlice(args);
  assert.equal(out.rowsAffected, 1);
  assert.equal(out.highWatermark, null, 'cursorless resources never mint a watermark');
  assert.equal(executed.length, 0);
  const ingest = calls.find((c) => c.url.includes('/ingest-rows'))!;
  const payload = JSON.parse(String(ingest.init.body)) as { rows: Record<string, unknown>[]; mode: string };
  assert.equal(payload.mode, 'replace');
  assert.equal(payload.rows[0]._batch_id, 'ds1.2026-07-01T10:00:00.000Z', 'deterministic per run start');
});

test('runKajabiSlice incremental retry reuses the given window; dispatch marker fires before landing', async () => {
  const calls: Call[] = [];
  const { fetchImpl } = fakeFetch(KJ_ROUTES([rec('9', { updated_at: '2026-06-10T00:00:00Z' })]), calls);
  const order: string[] = [];
  const { args, executed } = runArgs(fetchImpl, {
    watermark: '2026-06-01T00:00:00.000Z',
    window: { highWatermark: '2026-06-15T00:00:00.000Z' },
    onWindow: (hw: string, bid: string) => { order.push(`window:${hw}:${bid}`); },
  });
  const out = await runKajabiSlice(args);
  assert.equal(out.highWatermark, '2026-06-15T00:00:00.000Z', 'the unconfirmed window is re-covered');
  assert.ok(!calls.some((c) => c.url.includes('page%5Bsize%5D=1&')), 'no fresh probe over an unconfirmed slice');
  assert.equal(order.length, 1, 'the dispatch marker fired');
  assert.match(executed[0], /_batch_id/, 'delete-by-batch-id ran before the re-pull');
});

// ---- error-path: watermark-safety -------------------------------------------

test('pullKajabiSlice: 401 on page 2 surfaces honest error, watermark does not advance', async () => {
  const { fetchImpl } = fakeFetch([
    [(u) => u.includes('page%5Bnumber%5D=2'), () => mkRes(401, { error: 'unauthorized' })],
    ['/v1/purchases', () => mkRes(200, {
      data: [rec('2', { updated_at: '2026-06-10T00:00:00Z' })],
      links: { next: 'https://api.kajabi.com/v1/purchases?page[number]=2' },
    })],
  ]);
  const batches: unknown[] = [];
  const res = await pullKajabiSlice({
    conn: conn(fetchImpl), token: 'tok', resource: 'purchases', cursorField: 'updated_at',
    watermark: null, highWatermark: '2026-06-30T00:00:00.000Z',
    onBatch: async (r) => { batches.push(r); },
  });
  assert.ok(!res.ok, 'must surface the error');
  assert.match(res.reason, /401/, 'reason must mention the HTTP status');
  assert.equal(batches.length, 1, 'page-1 batch was delivered before the error — at-least-once');
});

test('pullKajabiSlice: malformed HTML body on page 2 surfaces parse error, watermark does not advance', async () => {
  const htmlRes = (): Response => ({
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => { throw new SyntaxError('unexpected token'); },
    text: async () => '<html>error</html>',
  } as unknown as Response);
  const { fetchImpl } = fakeFetch([
    [(u) => u.includes('page%5Bnumber%5D=2'), htmlRes],
    ['/v1/purchases', () => mkRes(200, {
      data: [rec('2', { updated_at: '2026-06-10T00:00:00Z' })],
      links: { next: 'https://api.kajabi.com/v1/purchases?page[number]=2' },
    })],
  ]);
  const batches: unknown[] = [];
  const res = await pullKajabiSlice({
    conn: conn(fetchImpl), token: 'tok', resource: 'purchases', cursorField: 'updated_at',
    watermark: null, highWatermark: '2026-06-30T00:00:00.000Z',
    onBatch: async (r) => { batches.push(r); },
  });
  assert.ok(!res.ok, 'must surface the parse error');
  assert.match(res.reason, /unreachable/i, 'caught JSON parse → Kajabi unreachable');
  assert.equal(batches.length, 1, 'page-1 batch was delivered before the error — at-least-once');
});

test('pullKajabiSlice: 429 on page 2 surfaces rate-limit error, watermark does not advance (mid-pagination)', async () => {
  const { fetchImpl } = fakeFetch([
    [(u) => u.includes('page%5Bnumber%5D=2'), () => mkRes(429, {})],
    ['/v1/purchases', () => mkRes(200, {
      data: [rec('2', { updated_at: '2026-06-10T00:00:00Z' })],
      links: { next: 'https://api.kajabi.com/v1/purchases?page[number]=2' },
    })],
  ]);
  const batches: unknown[] = [];
  const res = await pullKajabiSlice({
    conn: conn(fetchImpl), token: 'tok', resource: 'purchases', cursorField: 'updated_at',
    watermark: null, highWatermark: '2026-06-30T00:00:00.000Z',
    onBatch: async (r) => { batches.push(r); },
  });
  assert.ok(!res.ok, 'must surface the rate-limit error');
  assert.match(res.reason, /rate-limit/i, 'reason must mention rate-limiting');
  assert.equal(batches.length, 1, 'page-1 batch was delivered before the rate-limit — at-least-once');
});

test('runKajabiSlice surfaces a 429 honestly (no rate-limit contract exists — retry next run)', async () => {
  const routes: [string | ((u: string) => boolean), () => Response][] = [
    ['/v1/oauth/token', () => mkRes(200, { access_token: 'tok' })],
    ['/v1/purchases', () => mkRes(429, {})],
  ];
  const { fetchImpl } = fakeFetch(routes);
  const { args } = runArgs(fetchImpl);
  await assert.rejects(() => runKajabiSlice(args), /rate-limited/);
});
