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
import { createUser } from '@/lib/users';

/**
 * The OAuth 2.1 Authorization-Server core (PKCE codes, refresh rotation, DCR,
 * redirect allowlist, RFC 9728 / RFC 8414 metadata). Pure + in-memory, so it is
 * exercised directly here; the thin `next/server` route wrappers are covered by
 * `next build`. The issued access token flows through the SAME `resolveMcpUser`
 * as the copy-paste bearer, so identity + role floor are proven end-to-end.
 */

process.env.OS_PUBLIC_URL = 'https://os.example.com';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce() {
  const verifier = 'x'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

beforeEach(() => __resetOAuth());

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

test('registerClient issues a public client_id for an allowlisted redirect', () => {
  const c = registerClient({ redirect_uris: [REDIRECT], client_name: 'Claude' });
  assert.ok(c.clientId.startsWith('soa_client_'));
  assert.deepEqual(getClient(c.clientId)?.redirectUris, [REDIRECT]);
});

test('registerClient rejects an off-allowlist redirect and an empty list', () => {
  assert.throws(() => registerClient({ redirect_uris: ['https://evil.example/cb'] }), OAuthError);
  assert.throws(() => registerClient({ redirect_uris: [] }), OAuthError);
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

test('validateAuthorizeRequest enforces registered client + S256 PKCE', () => {
  const c = registerClient({ redirect_uris: [REDIRECT] });
  const good = new URLSearchParams({
    response_type: 'code',
    client_id: c.clientId,
    redirect_uri: REDIRECT,
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    state: 's1',
  });
  const v = validateAuthorizeRequest(good);
  assert.equal(v.clientId, c.clientId);
  assert.equal(v.state, 's1');
  assert.equal(v.scope, SCOPE);

  const unknownClient = new URLSearchParams(good);
  unknownClient.set('client_id', 'nope');
  assert.throws(() => validateAuthorizeRequest(unknownClient), (e: OAuthError) => e.code === 'invalid_client');

  const plain = new URLSearchParams(good);
  plain.set('code_challenge_method', 'plain');
  assert.throws(() => validateAuthorizeRequest(plain), OAuthError);
});

// ---- PKCE authorization-code flow ------------------------------------------

test('code exchange: PKCE happy path returns the bound user', () => {
  const { verifier, challenge } = pkce();
  const c = registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  const out = redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: verifier });
  assert.equal(out.userId, 'dan');
  assert.equal(out.scope, SCOPE);
});

test('code exchange: a wrong verifier is rejected', () => {
  const { challenge } = pkce();
  const c = registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  assert.throws(
    () => redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: 'wrong-verifier' }),
    (e: OAuthError) => e.code === 'invalid_grant',
  );
});

test('code exchange: a code is single-use', () => {
  const { verifier, challenge } = pkce();
  const c = registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: verifier });
  assert.throws(() => redeemCode(code, { clientId: c.clientId, redirectUri: REDIRECT, codeVerifier: verifier }), OAuthError);
});

test('code exchange: a code expires after its TTL', () => {
  const { verifier, challenge } = pkce();
  const c = registerClient({ redirect_uris: [REDIRECT] });
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

test('code exchange: a mismatched client_id or redirect_uri is rejected', () => {
  const { verifier, challenge } = pkce();
  const c = registerClient({ redirect_uris: [REDIRECT] });
  const code = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  assert.throws(() => redeemCode(code, { clientId: 'other', redirectUri: REDIRECT, codeVerifier: verifier }), OAuthError);
  // fresh code (previous consumed on the failed attempt)
  const code2 = issueCode({ userId: 'dan', clientId: c.clientId, redirectUri: REDIRECT, codeChallenge: challenge });
  assert.throws(
    () => redeemCode(code2, { clientId: c.clientId, redirectUri: 'https://claude.com/api/mcp/auth_callback', codeVerifier: verifier }),
    OAuthError,
  );
});

// ---- refresh-token rotation ------------------------------------------------

test('refresh token rotates: the old token dies after one use', () => {
  const rt = issueRefreshToken('dan', 'client-1');
  const out = redeemRefreshToken(rt, 'client-1');
  assert.equal(out.userId, 'dan');
  assert.throws(() => redeemRefreshToken(rt, 'client-1'), (e: OAuthError) => e.code === 'invalid_grant');
});

test('refresh token is bound to its client', () => {
  const rt = issueRefreshToken('dan', 'client-1');
  assert.throws(() => redeemRefreshToken(rt, 'client-2'), OAuthError);
});

// ---- access token = the existing envelope, extended ------------------------

test('access token is the signMcpToken envelope + aud/exp/scope/typ', () => {
  const { access_token, expires_in, scope } = issueAccessToken('dan');
  assert.equal(expires_in, 3600);
  assert.equal(scope, SCOPE);
  const payload = verifyMcpToken(access_token);
  assert.equal(payload?.id, 'dan');
  assert.equal(payload?.typ, 'access');
  assert.equal(payload?.aud, mcpResource());
  assert.equal(payload?.scope, SCOPE);
  assert.ok((payload?.exp ?? 0) > Math.floor(Date.now() / 1000));
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
