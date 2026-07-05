/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { registerClient, OAuthError } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';

/**
 * Dynamic Client Registration (RFC 7591). Claude POSTs its `redirect_uris`; we
 * validate them against the allowlist and return a generated public `client_id`
 * (no secret — `token_endpoint_auth_method: none`). Reachable unauthenticated.
 */
export async function POST(req: Request) {
  let body: { redirect_uris?: string[]; client_name?: string };
  try {
    body = (await req.json()) as { redirect_uris?: string[]; client_name?: string };
  } catch {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'invalid JSON body' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  try {
    const client = registerClient({ redirect_uris: body?.redirect_uris, client_name: body?.client_name });
    return NextResponse.json(
      {
        client_id: client.clientId,
        redirect_uris: client.redirectUris,
        client_name: client.clientName,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: client.created,
      },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    if (e instanceof OAuthError) {
      return NextResponse.json(
        { error: e.code, error_description: e.message },
        { status: e.status, headers: { 'cache-control': 'no-store' } },
      );
    }
    return NextResponse.json({ error: 'server_error', error_description: 'unexpected error' }, { status: 500 });
  }
}
