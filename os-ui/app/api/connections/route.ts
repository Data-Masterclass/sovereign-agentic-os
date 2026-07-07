/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { createConnection, listConnectionsForUser } from '@/lib/connections';
import { userFacingTemplates, isUserFacingTemplate, type ConnectionTemplateKey } from '@/lib/connection-model';
import { roleAtLeast } from '@/lib/session';
import { providerCatalog, ensureHydrated as ensureOAuthAppsHydrated } from '@/lib/oauth/oauth-apps';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** Governed connections visible to the caller (Personal + domain Shared + Marketplace). */
export async function GET() {
  try {
    const user = await requireUser();
    const connections = await listConnectionsForUser(user);
    // Only the three genuinely-working connectors are offered in the create picker.
    const templates = userFacingTemplates().map((t) => ({
      key: t.key,
      label: t.label,
      type: t.type,
      connector: t.connector,
      auth: t.auth,
      endpointHint: t.endpointHint,
    }));
    const canCreate = roleAtLeast(user.role, 'builder');
    // ANY user may create a PERSONAL (per-user OAuth) connection; SHARED needs Builder/Admin.
    const canCreatePersonal = true;
    // Which drive OAuth apps a platform admin has registered — lets the UI show an
    // honest "an administrator must configure this first" state (never a secret).
    await ensureOAuthAppsHydrated();
    const oauthProviders = providerCatalog().map((p) => ({ provider: p.provider, label: p.label, configured: p.configured }));
    return NextResponse.json({ user, connections, templates, canCreate, canCreatePersonal, oauthProviders });
  } catch (e) {
    return fail(e);
  }
}

/**
 * New connection (Builder/Admin only). Writes the credential to Secrets Manager
 * (record keeps only a ref), checks the egress allowlist for external endpoints,
 * compiles the safe-preset capability profile into the connection's OPA policy.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json();
    const name = String(body?.name ?? '').trim();
    const template = String(body?.template ?? '') as ConnectionTemplateKey;
    if (!name) return NextResponse.json({ error: 'A connection name is required' }, { status: 400 });
    if (!template) return NextResponse.json({ error: 'A connection template/type is required' }, { status: 400 });
    // The Connections tab may only create one of the three working connectors —
    // no user can stand up a non-working mock connection through this surface.
    if (!isUserFacingTemplate(template)) {
      return NextResponse.json({ error: 'This connector is not available' }, { status: 400 });
    }
    const conn = await createConnection(user, {
      name,
      template,
      endpoint: String(body?.endpoint ?? ''),
      credential: String(body?.credential ?? ''),
      domain: body?.domain ? String(body.domain) : undefined,
      openApiSpec: body?.openApiSpec,
    });
    return NextResponse.json({ connection: conn }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
