/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { accountStatus, disconnectAccount, setCredentialMode } from '@tabs/connections/lib/index';

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

/** Switch the credential mode. `shared` needs `sharedAcknowledged: true` and the scope's role. */
export const PATCH = withRoute<{ id: string }, { credentialMode?: unknown; sharedAcknowledged?: unknown }>(async ({ user, params, body }) => {
  await governed(user.id, 'connection_account_mode');
  const mode = body?.credentialMode;
  if (mode !== 'per_user' && mode !== 'shared') return NextResponse.json({ error: 'credentialMode must be per_user or shared' }, { status: 400 });
  const c = await setCredentialMode(params.id, user, mode, body?.sharedAcknowledged === true);
  return NextResponse.json({ id: c.id, credentialMode: c.credentialMode });
}, { parse: true, defaultStatus: 500 });
