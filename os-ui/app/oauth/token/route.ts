/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import {
  redeemCode,
  redeemRefreshToken,
  issueAccessToken,
  issueRefreshToken,
  OAuthError,
} from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';

/**
 * OAuth 2.1 token endpoint. Public client (no secret): `authorization_code`
 * verifies PKCE + client/redirect binding; `refresh_token` rotates. The access
 * token is the existing MCP bearer envelope (aud/exp/scope-enriched) so
 * `resolveMcpUser` validates it unchanged. Reachable unauthenticated.
 */
function tokenJson(body: Record<string, unknown>) {
  return NextResponse.json(body, {
    headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
  });
}

function errResponse(e: unknown) {
  if (e instanceof OAuthError) {
    return NextResponse.json(
      { error: e.code, error_description: e.message },
      { status: e.status, headers: { 'cache-control': 'no-store' } },
    );
  }
  return NextResponse.json({ error: 'server_error', error_description: 'unexpected error' }, { status: 500 });
}

export async function POST(req: Request) {
  const params = new URLSearchParams(await req.text());
  try {
    const grant = params.get('grant_type');

    if (grant === 'authorization_code') {
      const code = params.get('code') ?? '';
      const redirectUri = params.get('redirect_uri') ?? '';
      const clientId = params.get('client_id') ?? '';
      const codeVerifier = params.get('code_verifier') ?? '';
      if (!code || !redirectUri || !clientId || !codeVerifier) {
        throw new OAuthError('invalid_request', 'missing required parameter');
      }
      const { userId, scope } = redeemCode(code, { clientId, redirectUri, codeVerifier });
      const { access_token, expires_in } = issueAccessToken(userId, scope);
      const refresh_token = issueRefreshToken(userId, clientId);
      return tokenJson({ access_token, token_type: 'Bearer', expires_in, refresh_token, scope });
    }

    if (grant === 'refresh_token') {
      const refreshToken = params.get('refresh_token') ?? '';
      const clientId = params.get('client_id') ?? '';
      if (!refreshToken || !clientId) throw new OAuthError('invalid_request', 'missing required parameter');
      const { userId } = redeemRefreshToken(refreshToken, clientId);
      const { access_token, expires_in, scope } = issueAccessToken(userId);
      const refresh_token = issueRefreshToken(userId, clientId);
      return tokenJson({ access_token, token_type: 'Bearer', expires_in, refresh_token, scope });
    }

    throw new OAuthError('unsupported_grant_type', `unsupported grant_type: ${grant ?? '(none)'}`);
  } catch (e) {
    return errResponse(e);
  }
}
