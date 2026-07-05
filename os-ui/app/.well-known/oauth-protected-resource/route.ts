/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { protectedResourceMetadata } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';

/**
 * RFC 9728 Protected Resource Metadata (root variant). Points Claude's managed
 * authorization at this origin as the Authorization Server. Must be reachable
 * unauthenticated (see middleware allowlist).
 */
export function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: { 'cache-control': 'no-store' } });
}
