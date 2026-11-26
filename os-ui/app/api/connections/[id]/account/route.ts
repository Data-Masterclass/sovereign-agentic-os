/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { accountStatus, disconnectAccount, setCredentialMode, setMailSend } from '@tabs/connections/lib/index';

export const dynamic = 'force-dynamic';

/**
 * Governance before the effect (GLUE-7): the decision is recorded through the governed spine, the same
 * defense-in-depth pattern as the platform-admin context. A refusal is enforced by the store (role,
 * scope and visibility checks), and OPA's `os.external_mcp` decides every chat call on the connection.
 */
async function governed(userId: string, tool: string): Promise<void> {
  await authorize(`user:${userId}`, tool);
}

/** The caller's own account status on a connection: connected, as whom, since when. Never a token. */
export const GET = withRoute<{ id: string }>(async ({ user, params }) =>
  NextResponse.json(await accountStatus(params.id, user)), { defaultStatus: 500 });

/** Disconnect the caller's own account (per-user), or the shared credential (owner / manager). */
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  await governed(user.id, 'connection_account_disconnect');
  return NextResponse.json(await disconnectAccount(params.id, user));
}, { defaultStatus: 500 });

/**
 * Switch the credential mode (`credentialMode`; `shared` needs `sharedAcknowledged: true` and the scope's
 * role), or the Microsoft 365 switch "Allow drafting and sending mail" (`allowMailSend: boolean`; turning it
 * on needs a domain admin, or an administrator for a Company connection). One change per request.
 */
export const PATCH = withRoute<{ id: string }, { credentialMode?: unknown; sharedAcknowledged?: unknown; allowMailSend?: unknown }>(async ({ user, params, body }) => {
  if (body?.allowMailSend !== undefined) {
    await governed(user.id, 'connection_account_mail_send');
    if (typeof body.allowMailSend !== 'boolean') return NextResponse.json({ error: 'allowMailSend must be true or false' }, { status: 400 });
    const c = await setMailSend(params.id, user, body.allowMailSend);
    return NextResponse.json({ id: c.id, allowMailSend: c.allowMailSend === true });
  }
  await governed(user.id, 'connection_account_mode');
  const mode = body?.credentialMode;
  if (mode !== 'per_user' && mode !== 'shared') return NextResponse.json({ error: 'credentialMode must be per_user or shared' }, { status: 400 });
  const c = await setCredentialMode(params.id, user, mode, body?.sharedAcknowledged === true);
  return NextResponse.json({ id: c.id, credentialMode: c.credentialMode });
}, { parse: true, defaultStatus: 500 });
