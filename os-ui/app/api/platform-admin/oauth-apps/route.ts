/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { audit } from '@/lib/platform-admin/audit';
import { registerOAuthApp, listOAuthApps, providerCatalog, ensureHydrated } from '@/lib/oauth/oauth-apps';
import { asOAuthProvider } from '@/lib/oauth/providers';

export const dynamic = 'force-dynamic';

/**
 * Admin OAuth-app config — where the platform admin registers the Google Cloud
 * OAuth client and the Microsoft/Azure app the connected-drive flow uses. Same
 * provider-key discipline as model provider keys: the raw client SECRET is written
 * ONCE to Secrets Manager server-side; only a reference + fingerprint are kept and
 * returned. The client id (public) is stored plainly for the authorize URL.
 */
export async function GET() {
  try {
    await adminCtx();
    await ensureHydrated();
    return NextResponse.json({ apps: listOAuthApps(), catalog: providerCatalog() });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    await ensureHydrated();
    const body = await req.json();
    const provider = asOAuthProvider(String(body?.provider ?? '').trim());
    const clientId = String(body?.clientId ?? '').trim();
    const clientSecret = String(body?.clientSecret ?? '');
    if (!provider) return NextResponse.json({ error: 'provider must be google or microsoft' }, { status: 400 });
    if (!clientId || !clientSecret) return NextResponse.json({ error: 'A client id and client secret are required' }, { status: 400 });

    // The raw secret is written to Secrets Manager inside registerOAuthApp; the
    // record keeps only a ref + fingerprint (never the raw value).
    const app = registerOAuthApp({ provider, clientId, clientSecret, addedBy: user.id });
    audit({
      tenant: tenant.id,
      actor: user.id,
      role: user.role,
      action: 'oauth.app-config',
      target: `oauth:${provider}`,
      detail: `Registered ${provider} OAuth app (client ${clientId}); secret stored via secrets manager (${app.fingerprint}); raw value never surfaced`,
    });
    return NextResponse.json({ app }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
