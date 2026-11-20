/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    git-http path guard — encoded separators and dot segments are refused on both layers
 * USER STORY: As a domain member I want a git-over-HTTP request to reach exactly the repository the
 *             OS authorised, so a URL whose path a server decodes or normalises differently can
 *             never name a second repository.
 * ARCHITECTURE:
 *   - Layer 1: `authenticateGitRequest` (the ingress auth-url decision), fed exactly as the route
 *     feeds it (`originalRequestUri` from `X-Original-URL`).
 *   - Layer 2 (the git-http sidecar's lighttpd) is proved against the image built from the branch
 *     in its own CI job: tests/git-http/lighttpd-guard.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticateGitRequest, parseGitPath, unsafeGitPath } from '@core/auth/git-http-auth';
import { __resetAccessTokens, createAccessToken } from '@core/auth/access-tokens-store';
import { originalRequestUri } from '@core/infra/git-original-uri';

const MEMBER = { id: 'bob', name: 'Bob', role: 'builder', domains: ['sales'] };
const Q = '?service=git-upload-pack';
const VARIANTS = [
  `/git/sales.git/..%2ffinance.git/info/refs${Q}`,
  `/git/sales.git/..%2Ffinance.git/info/refs${Q}`,
  `/git/sales.git/%2e%2e%2ffinance.git/info/refs${Q}`,
  `/git/sales.git/%2E%2E%2Ffinance.git/info/refs${Q}`,
  `/git/sales.git%2f..%2ffinance.git/info/refs${Q}`,
  `/git/sales.git/..%5cfinance.git/info/refs${Q}`,
  `/git/sales.git/%252e%252e%252ffinance.git/info/refs${Q}`,
  `/git/sales.git//finance.git/info/refs${Q}`,
];

test('layer 1: a member is refused every encoded-separator / dot-segment variant, and served the plain path', async () => {
  __resetAccessTokens();
  const auth = `Basic ${Buffer.from(`git:${createAccessToken({ userId: MEMBER.id, name: 't' }).token}`).toString('base64')}`;
  const decide = async (raw: string) => {
    const uri = originalRequestUri({ get: (n: string) => (n === 'x-original-url' ? `https://os.example${raw}` : null) }, 'http://x/');
    return authenticateGitRequest({ authorization: auth, uri }, { lookup: async () => MEMBER });
  };
  assert.equal((await decide(`/git/sales.git/info/refs${Q}`)).ok, true);
  for (const raw of VARIANTS) {
    const o = await decide(raw);
    assert.equal(o.ok, false, `allowed: ${raw}`);
  }
  // plain `..` is normalised by the URL parser to the repo it really names — which is then judged
  assert.equal((await decide(`/git/sales.git/../finance.git/info/refs${Q}`)).ok, false);
  assert.equal(parseGitPath('/git/sales.git/info/refs')?.domain, 'sales');
  assert.equal(unsafeGitPath('/git/sales.git/objects/ab/cdef'), false);
  assert.equal(unsafeGitPath('/git/sales.git/%zz'), true, 'an undecodable path is refused');
});
