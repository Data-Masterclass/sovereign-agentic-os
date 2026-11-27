/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { getConnectionForUser, connectTarget } from '@tabs/connections/lib/index';
import { providerForTemplate } from '@core/auth/providers';
import { publicBaseUrl, safeReturnTo } from '@core/auth/redirect';
import { apiError } from '@core/kernel/route-server';
import { errorBodyOf } from '@core/kernel/server-message';

export const dynamic = 'force-dynamic';

/**
 * "Connect your account": the ONE link the chat card and the connection page use. Looks up the
 * connection (visible to the caller, connectable by them) and sends the browser to the right OAuth
 * start — Notion's hosted MCP flow, or the Microsoft/Google flow — keeping `returnTo`, so the user
 * lands back where they clicked (the Home chat). No token is handled here.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const connectionId = url.searchParams.get('connectionId') ?? '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(connectionId)) return apiError(400, 'connectionId is required', 'connections.connectionIdRequired');
    const conn = await getConnectionForUser(connectionId, user); // 404 if not visible
    if (!connectTarget(conn, user)) return apiError(403, 'You cannot connect an account to this connection', 'connections.cannotConnect');
    const returnTo = safeReturnTo(url.searchParams.get('returnTo')) ?? '/connections';
    const base = publicBaseUrl(req.url).replace(/\/+$/, '');
    const q = `connectionId=${encodeURIComponent(conn.id)}&returnTo=${encodeURIComponent(returnTo)}`;
    if (conn.template === 'notion-mcp') return NextResponse.redirect(`${base}/api/connections/notion/authorize?${q}`);
    const provider = providerForTemplate(conn.template);
    if (!provider) return apiError(400, 'This connection does not use an account sign-in', 'connections.noAccountSignIn');
    return NextResponse.redirect(`${base}/api/connections/oauth/${provider}/authorize?${q}`);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json(errorBodyOf(e), { status });
  }
}
