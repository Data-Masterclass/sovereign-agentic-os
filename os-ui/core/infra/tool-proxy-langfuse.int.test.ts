/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel infra
 * FEATURE:    Tool consoles — Langfuse served at /tools/langfuse through the os-ui proxy
 * USER STORY: As a platform admin I open the Langfuse console inside the OS, already signed in, and
 *             every page, script and API call it makes stays under /tools/langfuse.
 * ARCHITECTURE:
 *   - Integration test against a REAL Langfuse web container. Runs only with LANGFUSE_OSS_PROXY_URL
 *     (the container's origin, e.g. http://127.0.0.1:13041) and skips otherwise.
 *     scripts/tests/langfuse-oss/run.sh starts the langfuse-oss image and runs it.
 *   - Drives the os-ui proxy function itself (`proxy` in tool-proxy.ts) with the registry entry the OS
 *     derives from LANGFUSE_URL (`langfuseTool`) and the server-side NextAuth sign-in
 *     (`loginLangfuse`), exactly as app/(entry)/tools/[tool]/[[...path]]/route.ts does.
 *   - Negative twin: the same page requested at the site root (no base path) is not served.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = process.env.LANGFUSE_OSS_PROXY_URL ?? '';
const skip = ORIGIN ? false : 'LANGFUSE_OSS_PROXY_URL not set (scripts/tests/langfuse-oss/run.sh sets it)';

const OS = 'https://os.example';
const admin = { id: 'u-admin', name: 'Admin', domains: [], role: 'admin' as const };

async function setup() {
  const { langfuseTool, proxy, consoleAvailability, gateToolRequest } = await import('@core/infra/tool-proxy');
  const { loginLangfuse, hasLangfuseSession } = await import('@core/infra/tool-sso-langfuse');
  const tool = langfuseTool(`${ORIGIN}/tools/langfuse`, '');
  const sso = {
    active: (c: string | null) => hasLangfuseSession(c),
    provide: () => loginLangfuse({ fetchImpl: fetch, baseUrl: `${ORIGIN}/tools/langfuse`, email: 'parity@example.com', password: 'parity-password-1' }),
  };
  const get = (path: string, cookie = '') => {
    const segs = path.replace(/^\/tools\/langfuse\/?/, '').split(/[?#]/)[0].split('/').filter(Boolean).map(decodeURIComponent);
    return proxy(new Request(`${OS}${path}`, { headers: { host: 'os.example', 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) } }), tool, segs, admin, fetch, sso);
  };
  return { tool, get, consoleAvailability, gateToolRequest };
}

test('langfuse-oss through the os-ui proxy: available, signed in, everything under /tools/langfuse', { skip }, async () => {
  const { tool, get, consoleAvailability, gateToolRequest } = await setup();
  assert.equal(consoleAvailability(tool).state, 'available');
  assert.equal(gateToolRequest({ tool, path: [], role: 'admin', exposed: true }).status, 200);

  // The project's trace list: the proxy mints the NextAuth session server-side and sets it on the prefix.
  const page = await get('/tools/langfuse/project/parity-project/traces');
  assert.equal(page.status, 200, `trace list through the proxy: ${page.status}`);
  const setCookies = page.headers.getSetCookie();
  const session = setCookies.find((c) => /session-token=/.test(c));
  assert.ok(session, 'the minted Langfuse session is handed to the browser');
  assert.match(session!, /Path=\/tools\/langfuse/, 'scoped to the prefix');
  assert.match(session!, /Secure/);
  assert.match(session!, /SameSite=Strict/);
  const html = await page.text();
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('//'));
  assert.ok(refs.length > 10, `the page references its assets (${refs.length})`);
  const outside = refs.filter((r) => !r.startsWith('/tools/langfuse/'));
  assert.deepEqual(outside, [], 'no root-absolute reference that would hit os-ui\'s own routes');

  // A script chunk through the proxy.
  const js = refs.find((r) => r.includes('/_next/') && r.endsWith('.js'))!;
  const asset = await get(js);
  assert.equal(asset.status, 200, `asset ${js}`);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  await asset.arrayBuffer();

  // An API call the trace UI makes (tRPC), with the session the browser now holds.
  const cookie = session!.split(';')[0];
  const input = encodeURIComponent(JSON.stringify({ 0: { json: null, meta: { values: ['undefined'] } } }));
  const trpc = await get(`/tools/langfuse/api/trpc/organizations.all?batch=1&input=${input}`, cookie);
  assert.notEqual(trpc.status, 404, 'tRPC is reached under the prefix');
  const sess = await get('/tools/langfuse/api/auth/session', cookie);
  assert.equal(sess.status, 200);
  assert.equal((await sess.json() as { user?: { email?: string } }).user?.email, 'parity@example.com', 'the console is signed in as the service account');

  // A redirect from Langfuse stays inside the prefix.
  const root = await get('/tools/langfuse/');
  const loc = root.headers.get('location');
  if (root.status >= 300 && root.status < 400) assert.ok(loc?.startsWith('/tools/langfuse') || loc?.startsWith(`${OS}/tools/langfuse`), `redirect ${loc}`);
});

test('negative twin: without the base path the langfuse-oss server answers 404 (nothing escapes the prefix)', { skip }, async () => {
  const r = await fetch(`${ORIGIN}/project/parity-project/traces`, { redirect: 'manual' });
  assert.equal(r.status, 404);
  await r.arrayBuffer();
});
