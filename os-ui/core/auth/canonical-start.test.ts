/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    An OAuth start on an alias host moves to the canonical origin first (308)
 * USER STORY: As a user who opened the OS on os.<zone> while the OS's public URL is the apex, I
 *             want "Connect OneDrive" to finish instead of failing with invalid_state.
 * ARCHITECTURE:
 *   - `canonicalStartUrl` (core/auth/redirect.ts), called first by both authorize routes. The
 *     nonce cookie is host-only on the host that answered the start; the callback is always
 *     `callbackUri(OS_PUBLIC_URL)`. The twins pin the failure the redirect removes (start and
 *     callback on different origins) and that the target can never come from the Host header.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalStartUrl, callbackUri, publicBaseUrl } from '@core/auth/redirect';

const APEX = 'https://agentic.example.com';
const ALIAS_START = 'https://os.agentic.example.com/api/connections/oauth/microsoft/authorize?connectionId=conn_1';
const prev = process.env.OS_PUBLIC_URL;
afterEach(() => { if (prev === undefined) delete process.env.OS_PUBLIC_URL; else process.env.OS_PUBLIC_URL = prev; });

/** The origin whose cookie jar holds the nonce after the start answered (host-only cookie). */
const cookieOrigin = (startUrl: string) => new URL(startUrl).origin;

test('a start on the alias host is sent to the canonical origin, path and query kept', () => {
  process.env.OS_PUBLIC_URL = APEX;
  assert.equal(canonicalStartUrl(ALIAS_START, 'os.agentic.example.com'),
    'https://agentic.example.com/api/connections/oauth/microsoft/authorize?connectionId=conn_1');
});

test('after the redirect the nonce cookie and the callback share ONE origin', () => {
  process.env.OS_PUBLIC_URL = APEX;
  const start = canonicalStartUrl(ALIAS_START, 'os.agentic.example.com') ?? ALIAS_START;
  const callback = callbackUri(publicBaseUrl(start), 'microsoft');
  assert.equal(cookieOrigin(start), new URL(callback).origin);
});

test('twin: WITHOUT the redirect the cookie is set on os.<zone> but the provider returns to the apex (invalid_state)', () => {
  process.env.OS_PUBLIC_URL = APEX;
  const callback = callbackUri(publicBaseUrl(ALIAS_START), 'microsoft');
  assert.notEqual(cookieOrigin(ALIAS_START), new URL(callback).origin, 'the very mismatch the redirect removes');
});

test('a start already on the canonical host is not redirected (no loop)', () => {
  process.env.OS_PUBLIC_URL = `${APEX}/`;
  assert.equal(canonicalStartUrl(`${APEX}/api/connections/notion/authorize?connectionId=c`, 'agentic.example.com'), null);
});

test('twin: the target comes from OS_PUBLIC_URL only — a forged Host header cannot choose it', () => {
  process.env.OS_PUBLIC_URL = APEX;
  const to = canonicalStartUrl('https://evil.example.net/api/connections/oauth/google/authorize?connectionId=c', 'evil.example.net');
  assert.equal(new URL(to!).origin, APEX);
});

test('no canonical URL configured (local development) → never redirected', () => {
  delete process.env.OS_PUBLIC_URL;
  assert.equal(canonicalStartUrl(ALIAS_START, 'os.agentic.example.com'), null);
});
