/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { protectedResourceMetadata } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';

/**
 * RFC 9728 Protected Resource Metadata for the `/api/mcp` resource — the path
 * Claude probes from the 401 `resource_metadata` pointer (host + `.well-known`
 * inserted before the resource path).
 */
export function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: { 'cache-control': 'no-store' } });
}
