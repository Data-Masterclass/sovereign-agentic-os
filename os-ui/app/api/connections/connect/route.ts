/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { getConnectionForUser, connectTarget } from '@tabs/connections/lib/index';
import { providerForTemplate } from '@core/auth/providers';
import { publicBaseUrl, safeReturnTo } from '@core/auth/redirect';

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
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(connectionId)) return NextResponse.json({ error: 'connectionId is required' }, { status: 400 });
    const conn = await getConnectionForUser(connectionId, user); // 404 if not visible
    if (!connectTarget(conn, user)) return NextResponse.json({ error: 'You cannot connect an account to this connection' }, { status: 403 });
    const returnTo = safeReturnTo(url.searchParams.get('returnTo')) ?? '/connections';
    const base = publicBaseUrl(req.url).replace(/\/+$/, '');
    const q = `connectionId=${encodeURIComponent(conn.id)}&returnTo=${encodeURIComponent(returnTo)}`;
    if (conn.template === 'notion-mcp') return NextResponse.redirect(`${base}/api/connections/notion/authorize?${q}`);
    const provider = providerForTemplate(conn.template);
    if (!provider) return NextResponse.json({ error: 'This connection does not use an account sign-in' }, { status: 400 });
    return NextResponse.redirect(`${base}/api/connections/oauth/${provider}/authorize?${q}`);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
