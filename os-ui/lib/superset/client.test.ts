/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDashboardBundle, ensureEmbedded } from './client.ts';

const MANIFEST = JSON.stringify({
  dashboard: 'Sales Overview',
  database_service_name: 'trino',
  dataset: { name: 'Sales', schema: 'cube', sql: 'SELECT * FROM "Sales"' },
  charts: [{ name: 'Sales — revenue', viz_type: 'big_number_total', metric: 'revenue' }],
});

type Call = { url: string; method: string; init: RequestInit };

/** A fake fetch that mimics just enough of Superset's CSRF + import endpoints. */
function fakeFetch(calls: Call[], opts: { importStatus?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), init: init ?? {} });
    if (url.endsWith('/api/v1/security/csrf_token/')) {
      return new Response(JSON.stringify({ result: 'csrf-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=xyz; Path=/; HttpOnly' },
      });
    }
    if (url.endsWith('/api/v1/dashboard/import/')) {
      return new Response(JSON.stringify({ message: 'OK' }), { status: opts.importStatus ?? 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

test('imports as multipart form-data with the ZIP, overwrite + CSRF/cookie/service-user headers', async () => {
  const calls: Call[] = [];
  await importDashboardBundle('http://superset:8088', MANIFEST, fakeFetch(calls));

  // CSRF fetched first, then the import POST.
  assert.equal(calls[0].url, 'http://superset:8088/api/v1/security/csrf_token/');
  const imp = calls.find((c) => c.url.endsWith('/api/v1/dashboard/import/'))!;
  assert.equal(imp.method, 'POST');

  // Multipart body carries the ZIP as `formData`, plus overwrite + passwords.
  const body = imp.init.body as unknown as FormData;
  assert.ok(body instanceof FormData);
  assert.equal(body.get('overwrite'), 'true');
  assert.equal(body.get('passwords'), '{}');
  const file = body.get('formData') as unknown as Blob;
  assert.ok(file instanceof Blob);
  assert.ok(file.size > 0);

  // Auth/CSRF headers threaded through.
  const headers = imp.init.headers as Record<string, string>;
  assert.equal(headers['X-CSRFToken'], 'csrf-abc');
  assert.equal(headers['Cookie'], 'session=xyz');
  assert.equal(headers['X-Forwarded-User'], 'admin');
});

test('a non-2xx import throws (⇒ adapter ✗ ⇒ honest offline-mock fallback)', async () => {
  const calls: Call[] = [];
  await assert.rejects(
    () => importDashboardBundle('http://superset:8088', MANIFEST, fakeFetch(calls, { importStatus: 401 })),
    /Superset import failed \(401\)/,
  );
});

test('still attempts the import (no false success) when CSRF is unavailable', async () => {
  const calls: Call[] = [];
  const noCsrf: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), init: init ?? {} });
    if (url.endsWith('/api/v1/security/csrf_token/')) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify({ message: 'OK' }), { status: 200 });
  }) as unknown as typeof fetch;

  await importDashboardBundle('http://superset:8088', MANIFEST, noCsrf);
  const imp = calls.find((c) => c.url.endsWith('/api/v1/dashboard/import/'))!;
  assert.ok(imp, 'import POST still issued');
  const headers = imp.init.headers as Record<string, string>;
  assert.equal(headers['X-CSRFToken'], undefined); // no token available, but not fatal
});

/** Fake Superset for the embedded-registration endpoint. */
function fakeEmbedFetch(calls: Call[], existing?: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, init: init ?? {} });
    if (url.endsWith('/api/v1/security/csrf_token/')) {
      return new Response(JSON.stringify({ result: 'csrf-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=xyz; Path=/; HttpOnly' },
      });
    }
    if (url.endsWith('/api/v1/dashboard/7/embedded')) {
      if (method === 'GET') {
        return existing
          ? new Response(JSON.stringify({ result: { uuid: existing } }), { status: 200 })
          : new Response('not found', { status: 404 });
      }
      // POST creates the registration
      return new Response(JSON.stringify({ result: { uuid: 'uuid-new' } }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

test('ensureEmbedded returns the existing embedded uuid without re-registering', async () => {
  const calls: Call[] = [];
  const uuid = await ensureEmbedded('http://superset:8088', 7, fakeEmbedFetch(calls, 'uuid-existing'));
  assert.equal(uuid, 'uuid-existing');
  // GET only — no POST when already registered.
  assert.ok(!calls.some((c) => c.url.endsWith('/embedded') && c.method === 'POST'));
});

test('ensureEmbedded registers (POST) when none exists and threads CSRF/service-user headers', async () => {
  const calls: Call[] = [];
  const uuid = await ensureEmbedded('http://superset:8088', 7, fakeEmbedFetch(calls));
  assert.equal(uuid, 'uuid-new');
  const post = calls.find((c) => c.url.endsWith('/embedded') && c.method === 'POST')!;
  assert.ok(post, 'POST issued to create the embedded registration');
  const headers = post.init.headers as Record<string, string>;
  assert.equal(headers['X-CSRFToken'], 'csrf-abc');
  assert.equal(headers['Cookie'], 'session=xyz');
  assert.equal(headers['X-Forwarded-User'], 'admin');
  assert.equal(JSON.parse(post.init.body as string).allowed_domains.length, 0);
});

test('ensureEmbedded throws when registration fails (⇒ offline-mock fallback)', async () => {
  const failFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/v1/security/csrf_token/')) {
      return new Response(JSON.stringify({ result: 'csrf-abc' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/embedded') && (init?.method ?? 'GET').toUpperCase() === 'GET') return new Response('no', { status: 404 });
    return new Response('boom', { status: 500 });
  }) as unknown as typeof fetch;
  await assert.rejects(() => ensureEmbedded('http://superset:8088', 7, failFetch), /embedded-registration failed \(500\)/);
});
