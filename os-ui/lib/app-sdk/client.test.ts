/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsClient, joinUrl, withQuery } from './client.ts';
import { Forbidden, NotAuthenticated, OsError, UnsupportedQuery } from './errors.ts';

/** A recording fetch stub: returns a queued JSON response and captures the call. */
type Call = { url: string; init: RequestInit };
function stubFetch(
  responder: (
    url: string,
    init: RequestInit,
  ) => { status?: number; body?: unknown; text?: string; contentType?: string },
) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = responder(url, init);
    const status = r.status ?? 200;
    const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    // Default a JSON content-type (the OS's real governed routes send it); a test
    // can pass contentType:'text/html'/'' + text:'<...>' to exercise honest failure.
    const contentType = r.contentType ?? (r.text !== undefined ? '' : 'application/json');
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// ── URL helpers ───────────────────────────────────────────────────────────────

test('joinUrl keeps same-origin paths bare and joins a base without double slash', () => {
  assert.equal(joinUrl('', '/api/auth/me'), '/api/auth/me');
  assert.equal(joinUrl('https://os.example.com', '/api/auth/me'), 'https://os.example.com/api/auth/me');
  assert.equal(joinUrl('https://os.example.com/', '/api/auth/me'), 'https://os.example.com/api/auth/me');
});

test('withQuery appends only defined params and drops empties', () => {
  assert.equal(withQuery('/p', { a: 1, b: undefined, c: '' }), '/p?a=1');
  assert.equal(withQuery('/p', { b: undefined }), '/p');
});

// ── URL building + credentials per method ───────────────────────────────────────

test('whoami hits the session route with credentials included', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { user: { id: 'u1' } } }));
  const os = createOsClient({ fetch: fn });
  const me = await os.whoami();
  assert.equal(me.user?.id, 'u1');
  assert.equal(calls[0].url, '/api/auth/me');
  assert.equal((calls[0].init as RequestInit).credentials, 'include');
});

test('baseUrl is prefixed for a standalone (remote OS) client', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { user: null } }));
  const os = createOsClient({ baseUrl: 'https://os.example.com', fetch: fn });
  await os.whoami();
  assert.equal(calls[0].url, 'https://os.example.com/api/auth/me');
});

test('datasets.list / get build the governed dataset-registry URLs', async () => {
  const { fn, calls } = stubFetch(() => ({ body: {} }));
  const os = createOsClient({ fetch: fn });
  await os.datasets.list();
  await os.datasets.get('ds 1/x');
  assert.equal(calls[0].url, '/api/data/datasets');
  // id is URL-encoded
  assert.equal(calls[1].url, '/api/data/datasets/ds%201%2Fx');
});

test('datasets.query{nl} POSTs the NL question and resolves to a normalized QueryResult', async () => {
  // The REAL ask-route success shape (lib/data/ask.ts AskSuccess): top-level
  // columns/rows/rowCount + the grounded answer + the executed sql.
  const { fn, calls } = stubFetch(() => ({
    body: {
      ok: true,
      sql: 'SELECT name, spend FROM c ORDER BY spend DESC',
      columns: ['name', 'spend'],
      rows: [['Acme', '4200'], ['Globex', '3100']],
      rowCount: 2,
      answer: 'Acme is the top customer by spend.',
    },
  }));
  const os = createOsClient({ fetch: fn });
  const r = await os.datasets.query('d1', { nl: 'top customers?' });
  assert.equal(calls[0].url, '/api/data/ask');
  assert.equal((calls[0].init as RequestInit).method, 'POST');
  assert.deepEqual(JSON.parse(String((calls[0].init as RequestInit).body)), { question: 'top customers?' });
  // Resolves to { columns, rows } — no cast needed, the exact usage the brief teaches.
  assert.deepEqual(r.columns, ['name', 'spend']);
  assert.deepEqual(r.rows, [['Acme', '4200'], ['Globex', '3100']]);
  assert.equal(r.rowCount, 2);
  assert.equal(Number(r.rows?.[0]?.[1] ?? 0), 4200, 'a scalar reads cleanly off rows[0]');
  assert.equal(r.answer, 'Acme is the top customer by spend.');
  assert.equal(r.sql, 'SELECT name, spend FROM c ORDER BY spend DESC');
});

test('datasets.query{} falls back to the preview route and normalizes to a QueryResult', async () => {
  // The REAL preview-route success shape (lib/data/preview.ts): datasetId/name +
  // available + columns/rows/rowCount. Normalized to the same table.
  const { fn, calls } = stubFetch(() => ({
    body: { datasetId: 'd1', name: 'Orders', available: true, layer: 'gold', fqn: 'x', limit: 25, columns: ['id'], rows: [['1'], ['2']], rowCount: 2 },
  }));
  const os = createOsClient({ fetch: fn });
  const r = await os.datasets.query('d1', { limit: 25 });
  assert.equal(calls[0].url, '/api/data/datasets/d1/preview?limit=25');
  assert.deepEqual(r.columns, ['id']);
  assert.equal(r.rowCount, 2);
});

test('datasets.query on a not-materialized preview is an HONEST empty table (no fabricated rows)', async () => {
  // The preview route's not-built answer: { available:false, reason } — NO columns/rows.
  const { fn } = stubFetch(() => ({ body: { datasetId: 'd1', name: 'Orders', available: false, reason: 'build it first' } }));
  const os = createOsClient({ fetch: fn });
  const r = await os.datasets.query('d1', {});
  assert.deepEqual(r, { columns: [], rows: [], rowCount: 0 }, 'empty, not invented');
});

test('datasets.query{sql} is refused locally — no request, honest UnsupportedQuery', async () => {
  const { fn, calls } = stubFetch(() => ({ body: {} }));
  const os = createOsClient({ fetch: fn });
  // Refused up front — rejects before any request is made.
  await assert.rejects(() => os.datasets.query('d1', { sql: 'SELECT 1' }), UnsupportedQuery);
  assert.equal(calls.length, 0); // never touched the network
});

test('metrics.query POSTs the slice and normalizes member-keyed rows into a QueryResult table', async () => {
  // The REAL explorer shape (lib/metrics/build/explore-server.ts ExploreServerResult):
  // rows are member-KEYED OBJECTS, there is NO top-level columns array, plus sql/mode.
  const { fn, calls } = stubFetch(() => ({
    body: {
      metricId: 'm1',
      member: 'revenue',
      rows: [{ region: 'DE', revenue: 100.5 }, { region: 'FR', revenue: 50 }],
      sql: 'SELECT region, SUM(revenue) …',
      mode: 'live (sql)',
    },
  }));
  const os = createOsClient({ fetch: fn });
  const r = await os.metrics.query('m1', { dimensions: ['region'] });
  assert.equal(calls[0].url, '/api/metrics/explore');
  const body = JSON.parse(String((calls[0].init as RequestInit).body));
  assert.equal(body.metricId, 'm1');
  assert.deepEqual(body.dimensions, ['region']);
  // columns DERIVED from the row keys (first-seen order); rows FLATTENED into that order.
  assert.deepEqual(r.columns, ['region', 'revenue']);
  assert.deepEqual(r.rows, [['DE', '100.5'], ['FR', '50']]);
  assert.equal(r.rowCount, 2);
  assert.equal(Number(r.rows?.[0]?.[1] ?? 0), 100.5, 'a metric scalar reads off rows[0]');
  assert.equal(r.sql, 'SELECT region, SUM(revenue) …');
});

test('metrics.query on an unavailable/empty slice normalizes to an honest empty table', async () => {
  // The honesty-gate "unavailable" shape returns rows:[] — no fabricated number.
  const { fn } = stubFetch(() => ({ body: { metricId: 'm1', member: 'revenue', rows: [], sql: 'x', mode: 'unavailable', unavailable: true } }));
  const os = createOsClient({ fetch: fn });
  const r = await os.metrics.query('m1');
  assert.deepEqual(r.columns, []);
  assert.deepEqual(r.rows, []);
  assert.equal(r.rowCount, 0);
});

test('files.list / get build the governed file routes', async () => {
  const { fn, calls } = stubFetch(() => ({ body: {} }));
  const os = createOsClient({ fetch: fn });
  await os.files.list();
  await os.files.get('f1');
  assert.equal(calls[0].url, '/api/files');
  assert.equal(calls[1].url, '/api/files/f1');
});

// ── records (the app's OWN data — the governed WRITE surface) ───────────────────

test('records.list GETs the app-slug records route and unwraps { result }', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { result: { source: 'demo-seed', items: [] } } }));
  const os = createOsClient({ appSlug: 'northpeak-products', fetch: fn });
  const out = await os.records.list();
  assert.equal(calls[0].url, '/api/apps/by-slug/northpeak-products/records');
  assert.equal((calls[0].init as RequestInit).method ?? 'GET', 'GET');
  assert.equal(out.source, 'demo-seed');
});

test('records.add POSTs the record under { record } and unwraps { result }', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { result: { source: 'live-app', added: { id: 'r9' } } } }));
  const os = createOsClient({ appSlug: 'northpeak-products', fetch: fn });
  const out = await os.records.add({ name: 'Widget', amount: 12 });
  assert.equal(calls[0].url, '/api/apps/by-slug/northpeak-products/records');
  assert.equal((calls[0].init as RequestInit).method, 'POST');
  assert.deepEqual(JSON.parse(String((calls[0].init as RequestInit).body)), { record: { name: 'Widget', amount: 12 } });
  assert.equal(out.source, 'live-app');
});

test('records.get URL-encodes the id and hits /records/{id}', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { result: { source: 'demo-seed', item: null } } }));
  const os = createOsClient({ appSlug: 'app one', fetch: fn });
  await os.records.get('r 1/x');
  assert.equal(calls[0].url, '/api/apps/by-slug/app%20one/records/r%201%2Fx');
});

test('records.export POSTs to /records/export', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { result: { source: 'demo-seed', file: 'demo-export.csv' } } }));
  const os = createOsClient({ appSlug: 'northpeak-products', fetch: fn });
  const out = await os.records.export();
  assert.equal(calls[0].url, '/api/apps/by-slug/northpeak-products/records/export');
  assert.equal((calls[0].init as RequestInit).method, 'POST');
  assert.equal(out.file, 'demo-export.csv');
});

test('records.* without an appSlug throw a clear local error — never a mystery request', async () => {
  const { fn, calls } = stubFetch(() => ({ body: {} }));
  const os = createOsClient({ fetch: fn }); // no appSlug
  await assert.rejects(() => os.records.list(), (e: unknown) => {
    assert.ok(e instanceof OsError);
    assert.match((e as Error).message, /appSlug/);
    return true;
  });
  assert.equal(calls.length, 0, 'no request is made when the slug is missing');
});

test('records write refusal surfaces the OS 403 reason verbatim as Forbidden', async () => {
  const { fn } = stubFetch(() => ({ status: 403, body: { error: "'add_record' is not in this app's approved deploy envelope" } }));
  const os = createOsClient({ appSlug: 'northpeak-products', fetch: fn });
  await assert.rejects(() => os.records.add({ x: 1 }), (e: unknown) => {
    assert.ok(e instanceof Forbidden);
    assert.match((e as Forbidden).reason, /approved deploy envelope/);
    return true;
  });
});

// ── context composition ─────────────────────────────────────────────────────────

test('context composes the five governed per-kind feeds client-side', async () => {
  const { fn, calls } = stubFetch((url) => {
    const kind = new URL(url, 'http://x').searchParams.get('kind');
    return { body: { items: [{ id: `${kind}-1`, name: kind }] } };
  });
  const os = createOsClient({ fetch: fn });
  const ctx = await os.context();
  assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c.url.startsWith('/api/context/available?kind=')));
  assert.equal(ctx.data[0].id, 'data-1');
  assert.equal(ctx.metrics[0].id, 'metrics-1');
  assert.equal(ctx.knowledge[0].id, 'knowledge-1');
  assert.equal(ctx.files[0].id, 'files-1');
  assert.equal(ctx.connections[0].id, 'connections-1');
});

test('context WITH an appSlug hits the app-scoped endpoint and groups by kind', async () => {
  const { fn, calls } = stubFetch(() => ({
    body: {
      items: [
        { kind: 'data', id: 'ds_1', name: 'Orders', access: 'read-only' },
        { kind: 'metrics', id: 'm_1', name: 'Revenue', access: 'read-only' },
        { kind: 'knowledge', id: 'k_1', name: 'Playbook', access: 'read-only' },
      ],
    },
  }));
  const os = createOsClient({ appSlug: 'northpeak-products', fetch: fn });
  const ctx = await os.context();
  // ONE app-scoped call — not five generic available-context feeds.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/apps/by-slug/northpeak-products/context');
  assert.equal(ctx.data[0].id, 'ds_1');
  assert.equal(ctx.metrics[0].name, 'Revenue');
  assert.equal(ctx.knowledge[0].id, 'k_1');
  // Kinds with no grant stay empty (honest — the app was not granted them).
  assert.deepEqual(ctx.files, []);
  assert.deepEqual(ctx.connections, []);
});

test('context WITH an appSlug on an app with zero grants returns all-empty kinds', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { items: [] } }));
  const os = createOsClient({ appSlug: 'fresh-app', fetch: fn });
  const ctx = await os.context();
  assert.equal(calls.length, 1);
  assert.deepEqual(ctx, { connections: [], data: [], knowledge: [], files: [], metrics: [] });
});

// ── knowledge search ranking (governed feed, client-side rank) ──────────────────

test('knowledge.search ranks the DLS-scoped feed and drops non-matches', async () => {
  const { fn } = stubFetch(() => ({
    body: {
      docs: [
        { id: 'a', title: 'Invoice exceptions', excerpt: 'handling invoices', source: 'k', ingestedAt: null },
        { id: 'b', title: 'Unrelated', excerpt: 'nothing here', source: 'k', ingestedAt: null },
        { id: 'c', title: 'Invoice policy', excerpt: 'invoice rules', source: 'k', ingestedAt: null },
      ],
    },
  }));
  const os = createOsClient({ fetch: fn });
  const hits = await os.knowledge.search('invoice');
  assert.deepEqual(hits.map((h) => h.id), ['a', 'c']); // 'b' filtered out
});

// ── error mapping ───────────────────────────────────────────────────────────────

test('401 → NotAuthenticated', async () => {
  const { fn } = stubFetch(() => ({ status: 401, body: { error: 'sign in' } }));
  const os = createOsClient({ fetch: fn });
  await assert.rejects(() => os.datasets.list(), (e: unknown) => {
    assert.ok(e instanceof NotAuthenticated);
    assert.equal((e as NotAuthenticated).status, 401);
    return true;
  });
});

test('403 → Forbidden carries the server reason verbatim', async () => {
  const { fn } = stubFetch(() => ({ status: 403, body: { error: 'OPA: not in domain finance' } }));
  const os = createOsClient({ fetch: fn });
  await assert.rejects(() => os.datasets.get('d1'), (e: unknown) => {
    assert.ok(e instanceof Forbidden);
    assert.equal((e as Forbidden).reason, 'OPA: not in domain finance');
    assert.match((e as Forbidden).message, /OPA: not in domain finance/);
    return true;
  });
});

test('other non-2xx → OsError with the status and server reason', async () => {
  const { fn } = stubFetch(() => ({ status: 502, body: { error: 'trino down' } }));
  const os = createOsClient({ fetch: fn });
  await assert.rejects(() => os.metrics.list(), (e: unknown) => {
    assert.ok(e instanceof OsError);
    assert.equal((e as OsError).status, 502);
    assert.match((e as OsError).message, /trino down/);
    return true;
  });
});

test('a transport failure surfaces as OsError, never a fake success', async () => {
  const fn = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const os = createOsClient({ fetch: fn });
  await assert.rejects(() => os.files.list(), (e: unknown) => {
    assert.ok(e instanceof OsError);
    assert.equal((e as OsError).status, 0);
    return true;
  });
});

test('createOsClient throws early when no fetch is available at all', () => {
  const saved = globalThis.fetch;
  // Simulate a runtime without a global fetch and no injected one.
  (globalThis as { fetch?: unknown }).fetch = undefined;
  try {
    assert.throws(() => createOsClient(), OsError);
  } finally {
    (globalThis as { fetch?: unknown }).fetch = saved;
  }
});

// ── honest failure on an HTML / non-JSON 2xx (the SSO "Unrecognized token '<'" bug) ──

test('whoami on an HTML 200 fails HONESTLY with an OsError — never a raw JSON.parse crash', async () => {
  // The exact broken case: OS base URL empty → the fetch hits the app's own origin
  // and nginx serves the SPA index.html (200, text/html). The old code did
  // JSON.parse('<!doctype html>...') → "Unrecognized token '<'". Now: a clean OsError.
  const { fn } = stubFetch(() => ({
    status: 200,
    text: '<!doctype html><html><body>app shell</body></html>',
    contentType: 'text/html; charset=utf-8',
  }));
  const os = createOsClient({ fetch: fn });
  await assert.rejects(
    () => os.whoami(),
    (e: unknown) => {
      assert.ok(e instanceof OsError, 'is an OsError, not a SyntaxError');
      assert.ok(!/Unrecognized token/i.test((e as Error).message), 'not a raw parse crash');
      assert.match((e as Error).message, /non-JSON|not pointed at the Sovereign OS|OS_API_URL/i);
      return true;
    },
  );
});

test('a 200 with a leading "<" body (no/again wrong content-type) also fails honestly', async () => {
  const { fn } = stubFetch(() => ({ status: 200, text: '  <not json', contentType: '' }));
  const os = createOsClient({ fetch: fn });
  await assert.rejects(() => os.context(), (e: unknown) => e instanceof OsError);
});

test('a valid JSON 200 (correct content-type) still parses normally', async () => {
  const { fn } = stubFetch(() => ({ body: { user: { id: 'u9' } }, contentType: 'application/json' }));
  const os = createOsClient({ fetch: fn });
  const me = await os.whoami();
  assert.equal(me.user?.id, 'u9');
});

test('an empty 200 body is tolerated as null (not an error)', async () => {
  const { fn } = stubFetch(() => ({ status: 200, text: '', contentType: 'application/json' }));
  const os = createOsClient({ fetch: fn });
  assert.equal(await os.whoami(), null as unknown);
});
