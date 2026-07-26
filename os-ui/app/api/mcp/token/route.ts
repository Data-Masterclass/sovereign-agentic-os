/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { signMcpToken } from '@/lib/mcp/token';

export const dynamic = 'force-dynamic';

/**
 * Mint the signed-in user's personal MCP bearer token + the endpoint URL, so the
 * UI can show copy-paste import instructions for Claude / ChatGPT. Cookie-session
 * authenticated (requireUser) — the token is scoped to this user's live identity.
 * The signing secret never leaves the server; only the token is returned.
 */
export const GET = withRoute(async ({ user }) => {
  const token = signMcpToken(user.id);
  const origin = (process.env.OS_PUBLIC_URL ?? '').replace(/\/+$/, '');
  const endpoint = `${origin}/api/mcp`;
  return NextResponse.json({
    endpoint,
    path: '/api/mcp',
    token,
    role: user.role,
    id: user.id,
    name: user.name,
  });
}, { defaultStatus: 500 });
