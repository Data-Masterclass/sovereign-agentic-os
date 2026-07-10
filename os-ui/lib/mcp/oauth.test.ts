/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  registerClient,
  getClient,
  isAllowedRedirect,
  issueCode,
  redeemCode,
  issueAccessToken,
  issueRefreshToken,
  redeemRefreshToken,
  validateAuthorizeRequest,
  protectedResourceMetadata,
  authorizationServerMetadata,
  OAuthError,
  SCOPE,
  mcpResource,
  issuer,
  __resetOAuth,
} from './oauth.ts';
import { verifyMcpToken, resolveMcpUser } from './token.ts';
import { handleRpc, type JsonRpcResponse } from './server.ts';
import { createUser } from '@/lib/platform-admin/users';

/**
 * The OAuth 2.1 Authorization-Server core (PKCE codes, refresh rotation, DCR,
 * redirect allowlist, RFC 9728 / RFC 8414 metadata). Pure + in-memory, so it is
 * exercised directly here; the thin `next/server` route wrappers are covered by
 * `next build`. The issued access token flows through the SAME `resolveMcpUser`
 * as the copy-paste bearer, so identity + role floor are proven end-to-end.
 *
 * DURABILITY: client registrations + refresh tokens now mirror to OpenSearch so
 * they survive a pod roll (the `invalid_client` regression). Those paths run
 * against a scriptable fake of the OpenSearch REST surface (see `fakeCluster`);
 * every other test runs with NO cluster, proving the in-memory fallback.
 */

process.env.OS_PUBLIC_URL = 'https://os.example.com';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce() {
  const verifier = 'x'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

beforeEach(() => __resetOAuth());

// ---- fake OpenSearch cluster (durability tests only) -----------------------
// Minimal in-memory fake of the OpenSearch REST surface, FRESH by default (no
// indices — the state right after a deploy with an empty PVC). Non-OpenSearch
// URLs get a generic 200 so best-effort side-channels never fail the test.
type FakeIndex = { docs: Map<string, unknown> };
// `dropDelete` simulates a DELETE that never lands (mirror blip / dropped write):
// the doc is NOT removed and the call returns 503, so an atomic claim reports
// 'unreachable' and must refuse to treat the token as consumed.
function fakeCluster(opts: { dropDelete?: boolean } = {}) {
  const indices = new Map<string, FakeIndex>();
  const log: string[] = [];
  const orig = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const m = url.match(/^https?:\/\/opensearch:9200(\/.*)$/);
    if (!m) return json({});
    const path = m[1];
    const [, indexName, rest] = path.match(/^\/([^/?]+)(.*)$/) ?? [];
    log.push(`${method} ${path.split('?')[0]}`);
    const idx = indices.get(indexName);
    if (rest?.startsWith('/_count')) {
      return idx ? json({ count: idx.docs.size }) : json({ error: 'index_not_found_exception' }, 404);
    }
    if (rest?.startsWith('/_search')) {
      if (!idx) return json({ error: 'index_not_found_exception' }, 404);
      return json({ hits: { hits: [...idx.docs.values()].map((_source) => ({ _source })) } });
    }
    if (rest?.startsWith('/_doc/')) {
      const id = decodeURIComponent(rest.slice('/_doc/'.length).split('?')[0]);
      if (method === 'GET') {
        return idx?.docs.has(id) ? json({ _id: id, _source: idx.docs.get(id) }) : json({ found: false }, 404);
      }
      if (method === 'DELETE') {
        if (opts.dropDelete) return json({ error: 'unavailable' }, 503); // dropped: doc kept
        const existed = idx?.docs.delete(id) ?? false; // OpenSearch delete is atomic
        return existed ? json({ result: 'deleted' }) : json({ result: 'not_found' }, 404);
      }
      if (!idx) return json({ error: 'index_not_found_exception' }, 404);
      idx.docs.set(id, JSON.parse(String(init?.body ?? '{}')));
      return json({ result: 'created' });
    }
    if (method === 'PUT' && (rest === '' || rest.startsWith('?'))) {
      if (idx) return json({ error: 'resource_already_exists_exception' }, 400);
      indices.set(indexName, { docs: new Map() });
      return json({ acknowledged: true });
    }
    return json({});
  }) as typeof fetch;
  return {
    indices,
    log,
    docsOf: (index: string) => indices.get(index)?.docs ?? new Map<string, unknown>(),
    restore: () => { globalThis.fetch = orig; },
  };
}
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

// ---- metadata (RFC 9728 / RFC 8414) ----------------------------------------

test('protected-resource metadata points at this origin as the AS', () => {
  const m = protectedResourceMetadata();
  assert.equal(m.resource, 'https://os.example.com/api/mcp');
  assert.deepEqual(m.authorization_servers, ['https://os.example.com']);
  assert.deepEqual(m.scopes_supported, [SCOPE]);
  assert.deepEqual(m.bearer_methods_supported, ['header']);
});

test('authorization-server metadata advertises S256 + none + CIMD', () => {
  const m = authorizationServerMetadata();
  assert.equal(m.issuer, issuer());
  assert.equal(m.authorization_endpoint, 'https://os.example.com/oauth/authorize');
  assert.equal(m.token_endpoint, 'https://os.example.com/oauth/token');
  assert.equal(m.registration_endpoint, 'https://os.example.com/oauth/register');
  assert.ok(m.code_challenge_methods_supported.includes('S256'));
  assert.ok(m.token_endpoint_auth_methods_supported.includes('none'));
  assert.ok(m.grant_types_supported.includes('authorization_code'));
  assert.ok(m.grant_types_supported.includes('refresh_token'));
  assert.equal(m.client_id_metadata_document_supported, true);
});

// ---- dynamic client registration + redirect allowlist ----------------------

test('registerClient issues a public client_id for an allowlisted redirect', async () => {
  const c = await registerClient({ redirect_uris: [REDIRECT], client_name: 'Claude' });
  assert.ok(c.clientId.startsWith('soa_client_'));
  assert.deepEqual((await getClient(c.clientId))?.redirectUris, [REDIRECT]);
});

test('registerClient rejects an off-allowlist redirect and an empty list', async () => {
  await assert.rejects(() => registerClient({ redirect_uris: ['https://evil.example/cb'] }), OAuthError);
  await assert.rejects(() => registerClient({ redirect_uris: [] }), OAuthError);
});

test('redirect allowlist: claude.ai + claude.com + loopback only', () => {
  assert.ok(isAllowedRedirect('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(isAllowedRedirect('https://claude.com/api/mcp/auth_callback'));
  assert.ok(isAllowedRedirect('http://localhost:8976/callback'));
  assert.ok(isAllowedRedirect('http://127.0.0.1:5000/callback'));
  assert.ok(!isAllowedRedirect('https://claude.ai.evil.example/api/mcp/auth_callback'));
  assert.ok(!isAllowedRedirect('http://localhost/other'));
  assert.ok(!isAllowedRedirect('not-a-url'));
});

// ---- authorize request validation ------------------------------------------

test('validateAuthorizeRequest enforces registered client + S256 PKCE', async () => {
  const c = await registerClient({ redirect_uris: [REDIRECT] });
  const good = new URLSearchParams({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: REDIRECT,
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    state: 's1',
  });
  const v = await validateAuthorizeRequest(good);
  assert.equal(v.clientId, c.clientId);
  assert.equal(v.state, 's1');
  assert.equal(v.scope, SCOPE);

  const unknownClient = new URLSearchParams(good);
  unknownClient.set('client_id', 'nope');
  await assert.rejects(() => validateAuthorizeRequest(unknownClient), (e: OAuthError) => e.code === 'invalid_client');

  const plain = new URLSearchParams(good);
  plain.set('code_challenge_method', 'plain');
  await assert.rejects(() => validateAuthorizeRequest(plain), OAuthError);
});

test('validateAuthorizeRequest accepts a client-id metadata-document URL from a trusted origin (Claude flow, no registration)', async () => {
  const base = {
    response_type: 'code',
    redirect_uri: REDIRECT,
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    state: 'md',
  };
  // Hosted Claude passes client_id = an https URL to its metadata document.
  const cimd = new URLSearchParams({ ...base, client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata' });
  const v = await validateAuthorizeRequest(cimd);
  assert.equal(v.clientId, 'https://claude.ai/oauth/mcp-oauth-client-metadata');
  assert.equal(v.redirectUri, REDIRECT);

  // An untrusted-origin URL client_id is rejected (not just any URL is accepted).
  const evil = new URLSearchParams({ ...base, client_id: 'https://evil.example/meta' });
  await assert.rejects(() => validateAuthorizeRequest(evil), (e: OAuthError) => e.code === 'invalid_client');

  // A trusted-origin client_id with an OFF-allowlist redirect is still rejected
  // (the redirect allowlist, not the client_id, is the real gate).
  const badRedir = new URLSearchParams({
    ...base,
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    redirect_uri: 'https://evil.example/cb',
  });
  await assert.rejects(() => validateAuthorizeRequest(badRedir), (e: OAuthError) => e.code === 'invalid_request');
});

// ---- PKCE authorization-code flow ------------------------------------------

test('code exchange: PKCE happy path returns the bound user', async () => {
  const { verifier, challenge } = pkce();
  const c = await registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  const out = redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: verifier });
  assert.equal(out.userId, 'dan');
  assert.equal(out.scope, SCOPE);
});

test('code exchange: a wrong verifier is rejected', async () => {
  const { challenge } = pkce();
  const c = await registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  assert.throws(
    () => redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: 'wrong-verifier' }),
    (e: OAuthError) => e.code === 'invalid_grant',
  );
});

test('code exchange: a code is single-use', async () => {
  const { verifier, challenge } = pkce();
  const c = await registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: verifier });
  assert.throws(() => redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: verifier }), OAuthError);
});

test('code exchange: a code expires after its TTL', async () => {
  const { verifier, challenge } = pkce();
  const c = await registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    assert.throws(
      () => redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: verifier }),
      (e: OAuthError) => e.code === 'invalid_grant',
    );
  } finally {
    Date.now = realNow;
  }
});

test('code exchange: a mismatched client_id or redirect_uri is rejected', async () => {
  const { verifier, challenge } = pkce();
  const c = await registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  assert.throws(() => redeemCode(code, { clientId: 'other', redirectUri: REDIRECT, codeVerifier: verifier }), OAuthError);
  // fresh code (previous consumed on the failed attempt)
  const code2 = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  assert.throws(
    () => redeemCode(code2, { clientId: c.clientId, redirectUri: 'https://claude.com/api/mcp/auth_callback', codeVerifier: verifier }),
    OAuthError,
  );
});

// ---- codes are NOT persisted (short-lived, single-use → no replay surface) --

test('codes are NOT mirrored: issuing a code touches no OpenSearch index', async () => {
  const os = fakeCluster();
  try {
    __resetOAuth();
    const { challenge } = pkce();
    issueCode({ userId: 'dan', clientId: 'c1', redirectUri: REDIRECT, codeChallenge: challenge });
    await settle();
    assert.equal(os.indices.size, 0, 'no index was created for authorization codes');
    assert.equal(os.log.length, 0, 'issuing a code makes no OpenSearch call');
  } finally {
    os.restore();
    __resetOAuth();
  }
});

// ---- refresh-token rotation ------------------------------------------------

test('refresh token rotates: the old token dies after one use', async () => {
  const rt = issueRefreshToken('dan', 'client-1');
  const out = await redeemRefreshToken(rt, 'client-1');
  assert.equal(out.userId, 'dan');
  await assert.rejects(() => redeemRefreshToken(rt, 'client-1'), (e: OAuthError) => e.code === 'invalid_grant');
});

test('refresh token is bound to its client', async () => {
  const rt = issueRefreshToken('dan', 'client-1');
  await assert.rejects(() => redeemRefreshToken(rt, 'client-2'), OAuthError);
});

// ---- access token = the existing envelope, extended ------------------------

test('access token is the signMcpToken envelope + aud/exp/scope/typ', () => {
  const { access_token, expires_in, scope } = issueAccessToken('dan');
  // 180-day token so a cohort connection lasts the whole program (identity only;
  // role/OPA/DLS re-resolved live per call).
  assert.equal(expires_in, 15552000);
  assert.equal(scope, SCOPE);
  const payload = verifyMcpToken(access_token);
  assert.equal(payload?.id, 'dan');
  assert.equal(payload?.typ, 'access');
  assert.equal(payload?.aud, mcpResource());
  assert.equal(payload?.scope, SCOPE);
  assert.ok((payload?.exp ?? 0) > Math.floor(Date.now() / 1000));
});

// ---- durability across a pod roll (the invalid_client regression) ----------

test('durability: a registered client survives a pod roll via the mirror', async () => {
  const os = fakeCluster();
  try {
    __resetOAuth(); // fresh pod: empty in-memory + fresh mirror health
    const c = await registerClient({ redirect_uris: [REDIRECT], client_name: 'Claude' });
    await settle();
    assert.ok(os.docsOf('os-oauth-clients').has(c.clientId), 'client persisted to the mirror');

    // Pod roll: wipe the in-memory Map (+ mirror health) but KEEP the cluster.
    __resetOAuth();
    const back = await getClient(c.clientId);
    assert.ok(back, 'client resolves after the roll via the mirror');
    assert.equal(back!.clientId, c.clientId);
    assert.deepEqual(back!.redirectUris, [REDIRECT]);

    // …and authorize now SUCCEEDS instead of hard-failing invalid_client.
    const params = new URLSearchParams({
      response_type: 'code', client_id: c.clientId, redirect_uri: REDIRECT,
      code_challenge: 'abc', code_challenge_method: 'S256',
    });
    const v = await validateAuthorizeRequest(params);
    assert.equal(v.clientId, c.clientId);
  } finally {
    os.restore();
    __resetOAuth();
  }
});

test('durability: a refresh token survives a pod roll and stays single-use', async () => {
  const os = fakeCluster();
  try {
    __resetOAuth();
    const rt = issueRefreshToken('dan', 'client-1');
    await settle();
    assert.equal(os.docsOf('os-oauth-refresh').size, 1, 'refresh token persisted to the mirror');

    // Pod roll: in-memory refresh Map gone → must read through the mirror.
    __resetOAuth();
    const out = await redeemRefreshToken(rt, 'client-1');
    assert.equal(out.userId, 'dan');
    await settle();

    // Rotation is enforced across the roll: the mirror doc was deleted on use.
    await assert.rejects(() => redeemRefreshToken(rt, 'client-1'), (e: OAuthError) => e.code === 'invalid_grant');
  } finally {
    os.restore();
    __resetOAuth();
  }
});

test('durability: an unknown client still throws invalid_client (mirror up, no doc)', async () => {
  const os = fakeCluster();
  try {
    __resetOAuth();
    // Seed the index by registering one client, then ask for a different id.
    await registerClient({ redirect_uris: [REDIRECT] });
    await settle();
    const params = new URLSearchParams({
      response_type: 'code', client_id: 'soa_client_does_not_exist', redirect_uri: REDIRECT,
      code_challenge: 'abc', code_challenge_method: 'S256',
    });
    await assert.rejects(() => validateAuthorizeRequest(params), (e: OAuthError) => e.code === 'invalid_client');
  } finally {
    os.restore();
    __resetOAuth();
  }
});

// ---- single-use is DURABLY enforced (the review's two blockers) ------------

test('durability: a dropped mirror DELETE cannot resurrect a rotated refresh token', async () => {
  // The exact regression: on a rolled pod the mirror is the only record, and a
  // fire-and-forget delete that never lands would let getDoc re-serve the token.
  // With the atomic claim, a DELETE that can't be confirmed → the redeem is
  // REJECTED, so the token is never accepted twice (Claude re-authorizes).
  const os = fakeCluster({ dropDelete: true });
  try {
    __resetOAuth();
    const rt = issueRefreshToken('dan', 'client-1');
    await settle();
    __resetOAuth(); // pod roll → in-memory gone, mirror keeps the doc

    // The claim's DELETE never lands ⇒ 'unreachable' ⇒ reject (no mint).
    await assert.rejects(() => redeemRefreshToken(rt, 'client-1'), (e: OAuthError) => e.code === 'invalid_grant');
    // And no second attempt can succeed either — the token is never resurrected.
    await assert.rejects(() => redeemRefreshToken(rt, 'client-1'), OAuthError);
    assert.equal(os.docsOf('os-oauth-refresh').size, 1, 'doc survives (delete was dropped) but was never re-accepted');
  } finally {
    os.restore();
    __resetOAuth();
  }
});

test('durability: two concurrent redeems of the same rolled token — exactly one wins', async () => {
  const os = fakeCluster();
  try {
    __resetOAuth();
    const rt = issueRefreshToken('dan', 'client-1');
    await settle();
    __resetOAuth(); // pod roll → both redeems must read through the mirror

    const results = await Promise.allSettled([
      redeemRefreshToken(rt, 'client-1'),
      redeemRefreshToken(rt, 'client-1'),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1, 'exactly one redeem mints a token');
    assert.equal(lost.length, 1, 'the TOCTOU double-redeem is rejected');
  } finally {
    os.restore();
    __resetOAuth();
  }
});

test('mirror-down: a just-registered client stays resolvable in-process (no hydrate overwrite)', async () => {
  // No fake cluster → the mirror is unreachable → writeThrough no-ops and every
  // hydrate returns null. The in-process Map must still hold the registration,
  // and a re-hydrate attempt must MERGE (never replace) so it is not dropped.
  __resetOAuth();
  const c = await registerClient({ redirect_uris: [REDIRECT], client_name: 'Claude' });
  const back = await getClient(c.clientId); // triggers another (failed) hydrate
  assert.ok(back, 'client resolvable in-process with the mirror down');
  assert.equal(back!.clientId, c.clientId);
  const params = new URLSearchParams({
    response_type: 'code', client_id: c.clientId, redirect_uri: REDIRECT,
    code_challenge: 'abc', code_challenge_method: 'S256',
  });
  const v = await validateAuthorizeRequest(params);
  assert.equal(v.clientId, c.clientId);
});

// ---- governance: OAuth token resolves to the SAME live identity + role floor

test('OAuth access token resolves to the live identity; role floor is preserved', async () => {
  await createUser({
    id: 'oauth-creator',
    name: 'OAuth Creator',
    password: 'pw-strong-123',
    domains: ['sales'],
    role: 'creator',
    email: 'oauth-creator@example.com',
  }).catch(() => {});

  const { access_token } = issueAccessToken('oauth-creator');
  const user = await resolveMcpUser(access_token);
  assert.equal(user?.id, 'oauth-creator');
  assert.equal(user?.role, 'creator'); // role re-resolved LIVE, never frozen in the token

  // A creator's OAuth token still cannot call an elevated (builder+) tool.
  const denied = (await handleRpc(user!, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'promote', arguments: { appId: 'whatever' } },
  })) as JsonRpcResponse;
  const r = denied.result as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent?.error?.code, 'forbidden');
});

test('a refresh token cannot be used as an MCP bearer', async () => {
  const rt = issueRefreshToken('oauth-creator', 'client-1');
  assert.equal(await resolveMcpUser(rt), null);
});
