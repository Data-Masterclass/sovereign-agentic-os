/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra / engineer's door
 * FEATURE:    originalRequestUri — header precedence for the ingress auth sub-request
 * USER STORY: As a maintainer I want the auth endpoint to keep working without the forbidden
 *             `auth-snippet`, by reading ingress-nginx's default `X-Original-URL`.
 * ARCHITECTURE: pure unit tests over a Headers-like reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalRequestUri } from './git-original-uri.ts';

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
const REQ = 'http://os-ui:3000/api/git/authenticate';

test('X-Original-URL (the ingress-nginx default) wins and yields path + query', () => {
  assert.equal(
    originalRequestUri(h({ 'x-original-url': 'https://os.example/git/sales.git/info/refs?service=git-receive-pack' }), REQ),
    '/git/sales.git/info/refs?service=git-receive-pack',
  );
});

test('X-Original-URI is still honoured when a controller sets it', () => {
  assert.equal(originalRequestUri(h({ 'x-original-uri': '/git/sales.git/git-upload-pack' }), REQ), '/git/sales.git/git-upload-pack');
});

test('an explicit ?uri= is the last resort (curl, tests)', () => {
  assert.equal(originalRequestUri(h({}), `${REQ}?uri=%2Fgit%2Fsales.git%2Finfo%2Frefs`), '/git/sales.git/info/refs');
});

test('a malformed X-Original-URL never throws and falls through', () => {
  assert.equal(originalRequestUri(h({ 'x-original-url': 'not a url', 'x-original-uri': '/git/x.git/info/refs' }), REQ), '/git/x.git/info/refs');
  assert.equal(originalRequestUri(h({ 'x-original-url': '::' }), REQ), '');
});
