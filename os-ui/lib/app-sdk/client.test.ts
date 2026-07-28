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

test('datasets.query{nl} POSTs the NL question to the governed ask route', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { ok: true, rowCount: 3 } }));
  const os = createOsClient({ fetch: fn });
  const out = (await os.datasets.query('d1', { nl: 'top customers?' })) as { rowCount: number };
  assert.equal(calls[0].url, '/api/data/ask');
  assert.equal((calls[0].init as RequestInit).method, 'POST');
  assert.deepEqual(JSON.parse(String((calls[0].init as RequestInit).body)), { question: 'top customers?' });
  assert.equal(out.rowCount, 3);
});

test('datasets.query{} falls back to the governed preview route with a limit', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { available: true } }));
  const os = createOsClient({ fetch: fn });
  await os.datasets.query('d1', { limit: 25 });
  assert.equal(calls[0].url, '/api/data/datasets/d1/preview?limit=25');
});

test('datasets.query{sql} is refused locally — no request, honest UnsupportedQuery', async () => {
  const { fn, calls } = stubFetch(() => ({ body: {} }));
  const os = createOsClient({ fetch: fn });
  // Refused up front — rejects before any request is made.
  await assert.rejects(() => os.datasets.query('d1', { sql: 'SELECT 1' }), UnsupportedQuery);
  assert.equal(calls.length, 0); // never touched the network
});

test('metrics.query POSTs the slice to the governed explorer', async () => {
  const { fn, calls } = stubFetch(() => ({ body: { rows: [] } }));
  const os = createOsClient({ fetch: fn });
  await os.metrics.query('m1', { dimensions: ['region'] });
  assert.equal(calls[0].url, '/api/metrics/explore');
  const body = JSON.parse(String((calls[0].init as RequestInit).body));
  assert.equal(body.metricId, 'm1');
  assert.deepEqual(body.dimensions, ['region']);
});

test('files.list / get build the governed file routes', async () => {
  const { fn, calls } = stubFetch(() => ({ body: {} }));
  const os = createOsClient({ fetch: fn });
  await os.files.list();
  await os.files.get('f1');
  assert.equal(calls[0].url, '/api/files');
  assert.equal(calls[1].url, '/api/files/f1');
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
