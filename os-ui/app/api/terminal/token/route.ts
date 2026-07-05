/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { createHmac, randomBytes } from 'node:crypto';
import { config } from '@/lib/config';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Mints a short-lived (60s), single-use token authorising ONE terminal session
 * for the signed-in user, and returns the broker WebSocket URL the browser
 * should connect to. This is the OS-role authorization gate for the Terminal
 * tab: only an authenticated user whose role is in `terminalAllowedRoles` gets a
 * token. The token is signed with `terminalBrokerSecret` (the SAME value the
 * terminal-broker verifies with) and carries the user's id/role/domains so the
 * broker (and, later, the sandbox's governed-data scoping) can act on them.
 *
 * The secret never leaves the server; the browser only ever sees the opaque
 * token + the ws URL.
 */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function POST() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }
  if (!config.terminalEnabled) {
    return NextResponse.json({ error: 'terminal disabled' }, { status: 404 });
  }
  if (!config.terminalAllowedRoles.includes(user.role)) {
    return NextResponse.json({ error: 'not authorised for terminal' }, { status: 403 });
  }
  // Fail honestly when the deployment has no browser-reachable broker URL
  // (ingress on, ingress.hosts.terminal unset => chart renders "") instead of
  // handing the browser a token for a WebSocket it can never open.
  if (!config.terminalBrokerWsUrl) {
    return NextResponse.json(
      { error: 'terminal broker is not reachable from the browser on this deployment — set ingress.hosts.terminal in the chart values' },
      { status: 503 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: user.id,
    role: user.role,
    domains: user.domains,
    sid: randomBytes(12).toString('hex'),
    iat: now,
    exp: now + 60, // 60s to establish the WebSocket; single-use (sid) at the broker
  };
  const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64url(createHmac('sha256', config.terminalBrokerSecret).update(body).digest());
  const token = `${body}.${sig}`;

  return NextResponse.json({ token, wsUrl: config.terminalBrokerWsUrl, expiresIn: 60 });
}
