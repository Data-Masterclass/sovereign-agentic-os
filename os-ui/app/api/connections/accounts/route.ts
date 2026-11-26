/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { createAccountConnection, listConnectionsForUser, accountStatus, effectiveCredentialMode, ACCOUNT_TEMPLATES, accountLabel, mailSendAllowed, canAllowMailSend } from '@tabs/connections/lib/index';
import { ensureHydrated as ensureOAuthApps, isConfigured } from '@core/auth/oauth-apps';

export const dynamic = 'force-dynamic';

/**
 * Governance before the effect (GLUE-7): the decision is recorded through the governed spine, the same
 * defense-in-depth pattern as the platform-admin context. A refusal is enforced by the store (role,
 * scope and visibility checks), and OPA's `os.external_mcp` decides every chat call on the connection.
 */
async function governed(userId: string, tool: string): Promise<void> {
  await authorize(`user:${userId}`, tool);
}

/**
 * The account connections the caller can see (Notion, OneDrive, Microsoft 365, Google Drive) with
 * their own status on each, and whether the admin's OAuth app for the provider is configured.
 */
export const GET = withRoute(async ({ user }) => {
  await ensureOAuthApps();
  const conns = (await listConnectionsForUser(user)).filter((c) => ACCOUNT_TEMPLATES.has(c.template));
  const out = [];
  for (const c of conns) {
    const status = await accountStatus(c.id, user);
    const provider = c.template === 'notion-mcp' ? null : c.template === 'gdrive' ? 'google' : 'microsoft';
    out.push({
      id: c.id, name: c.name, template: c.template, label: accountLabel(c), visibility: c.visibility, domain: c.domain, owner: c.owner,
      credentialMode: effectiveCredentialMode(c), status,
      oauthAppConfigured: provider ? isConfigured(provider) : true,
      ...(c.template === 'microsoft-365' ? { mailSend: { allowed: mailSendAllowed(c), canChange: canAllowMailSend(c, user) } } : {}),
    });
  }
  return NextResponse.json({ accounts: out });
}, { defaultStatus: 500 });

/** Add an account connection: { kind, name?, scope: my|domain|company, credentialMode?, sharedAcknowledged?, allowMailSend? }. */
export const POST = withRoute<Record<string, never>, { kind?: unknown; name?: unknown; scope?: unknown; credentialMode?: unknown; sharedAcknowledged?: unknown; domain?: unknown; allowMailSend?: unknown }>(async ({ user, body }) => {
  await governed(user.id, 'connection_account_create');
  const scope = body?.scope === 'domain' || body?.scope === 'company' ? body.scope : 'my';
  const c = await createAccountConnection(user, {
    kind: String(body?.kind ?? ''),
    name: typeof body?.name === 'string' ? body.name : undefined,
    scope,
    credentialMode: body?.credentialMode === 'shared' ? 'shared' : 'per_user',
    sharedAcknowledged: body?.sharedAcknowledged === true,
    domain: typeof body?.domain === 'string' ? body.domain : undefined,
    allowMailSend: body?.allowMailSend === true,
  });
  return NextResponse.json({ id: c.id, name: c.name, template: c.template, visibility: c.visibility, credentialMode: c.credentialMode, allowMailSend: c.allowMailSend === true }, { status: 201 });
}, { parse: true, defaultStatus: 500 });
