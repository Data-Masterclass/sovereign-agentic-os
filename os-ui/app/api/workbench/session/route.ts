/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { createHmac, randomBytes } from 'node:crypto';
import { config } from '@/lib/config';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Mints a short-lived (60s), single-use token authorising ONE workbench session
 * for the signed-in builder, SCOPED TO ONE DOMAIN, and returns the broker URL the
 * browser should open. This is the OS-role + domain authorization gate for the
 * Workbench tab:
 *
 *   - only an authenticated user whose role is in `workbenchAllowedRoles` (builder
 *     / admin) gets a token;
 *   - the requested `domain` MUST be one the user belongs to (a builder cannot mint
 *     a token for a domain they are not in — this is the cross-domain cut);
 *   - the token carries `sub`, `role`, `domain` (the single chosen scope) and the
 *     full `domains` list (so the broker can re-verify membership), signed with
 *     `workbenchBrokerSecret` (the SAME value the workbench-broker verifies with).
 *
 * The secret never leaves the server; the browser only ever sees the opaque token
 * + the broker URL.
 */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }
  if (!config.workbenchEnabled) {
    return NextResponse.json({ error: 'workbench disabled' }, { status: 404 });
  }
  if (!config.workbenchAllowedRoles.includes(user.role)) {
    return NextResponse.json({ error: 'not authorised for workbench' }, { status: 403 });
  }
  // Fail honestly when the deployment has no browser-reachable broker URL
  // (ingress on, ingress.hosts.workbench unset => chart renders "") instead of
  // handing the browser a token for a broker it can never reach.
  if (!config.workbenchBrokerUrl) {
    return NextResponse.json(
      { error: 'workbench broker is not reachable from the browser on this deployment — set ingress.hosts.workbench in the chart values' },
      { status: 503 },
    );
  }

  // Resolve the requested domain; default to the user's first domain. A builder
  // can ONLY open a workbench for a domain they belong to.
  let requested: string | undefined;
  try {
    const body = (await req.json()) as { domain?: string };
    requested = body?.domain;
  } catch {
    /* no body => default domain */
  }
  const domain = requested ?? user.domains[0];
  if (!domain || !user.domains.includes(domain)) {
    return NextResponse.json({ error: 'not a member of that domain' }, { status: 403 });
  }

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: user.id,
    role: user.role,
    domain, // the single domain this workbench is scoped to
    domains: user.domains, // membership set (broker re-checks domain ∈ domains)
    sid: randomBytes(12).toString('hex'),
    iat: now,
    exp: now + 60, // 60s to establish the session; single-use (sid) at the broker
  };
  const bodyB64 = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = b64url(createHmac('sha256', config.workbenchBrokerSecret).update(bodyB64).digest());
  const token = `${bodyB64}.${sig}`;

  return NextResponse.json({
    token,
    brokerUrl: config.workbenchBrokerUrl,
    domain,
    expiresIn: 60,
  });
}
