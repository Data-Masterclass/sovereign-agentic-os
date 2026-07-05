/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { authorizationServerMetadata } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';

/**
 * RFC 8414 Authorization Server Metadata: the endpoints + capabilities Claude
 * enforces before it proceeds (S256 PKCE, `token_endpoint_auth_methods: none`,
 * authorize + token + registration endpoints). Reachable unauthenticated.
 */
export function GET() {
  return NextResponse.json(authorizationServerMetadata(), { headers: { 'cache-control': 'no-store' } });
}
