/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { createConnection, listConnectionsForUser, type WarehouseCreateInput } from '@/lib/connections';
import { userFacingTemplates, isUserFacingTemplate, templateByKey, type ConnectionTemplateKey } from '@/lib/connections';
import { roleAtLeast } from '@/lib/core/session';
import { providerCatalog, ensureHydrated as ensureOAuthAppsHydrated } from '@/lib/oauth/oauth-apps';
import { config } from '@/lib/core/config';
import { WAREHOUSE_PROVIDERS } from '@/lib/connections/warehouse/registry';
import { WAREHOUSE_PLATFORMS, type WarehousePlatform } from '@/lib/connections/warehouse/types';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** Governed connections visible to the caller (Personal + domain Shared + Marketplace). */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    // ?archived=1 additionally returns soft-archived connections (hidden by default).
    const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
    const connections = await listConnectionsForUser(user, { includeArchived });
    // Only the three genuinely-working connectors are offered in the create picker.
    const templates = userFacingTemplates().map((t) => ({
      key: t.key,
      label: t.label,
      type: t.type,
      connector: t.connector,
      auth: t.auth,
      endpointHint: t.endpointHint,
    }));
    // External-warehouse federation — surfaced ONLY when the operator has enabled it.
    // The picker gets the warehouse template + each provider's credential fields, so
    // the form renders generically from provider metadata (no hardcoded per-platform
    // fields). Nothing here appears when EXTERNAL_CONNECTORS_ENABLED is off.
    const warehouse = config.externalConnectorsEnabled
      ? {
          enabled: true,
          template: (() => {
            const t = templateByKey('warehouse')!;
            return { key: t.key, label: t.label, type: t.type, connector: t.connector, auth: t.auth, endpointHint: t.endpointHint };
          })(),
          providers: WAREHOUSE_PLATFORMS.map((p) => {
            const pr = WAREHOUSE_PROVIDERS[p];
            return {
              platform: pr.platform,
              label: pr.label,
              capabilities: pr.capabilities,
              credentialFields: pr.credentialFields,
              secretKeys: pr.secretMaterial.secretKeys,
              liveVerificationRequired: pr.liveVerificationRequired,
            };
          }),
        }
      : { enabled: false as const };
    const canCreate = roleAtLeast(user.role, 'builder');
    // ANY user may create a PERSONAL (per-user OAuth) connection; SHARED needs Builder/Admin.
    const canCreatePersonal = true;
    // Which drive OAuth apps a platform admin has registered — lets the UI show an
    // honest "an administrator must configure this first" state (never a secret).
    await ensureOAuthAppsHydrated();
    const oauthProviders = providerCatalog().map((p) => ({ provider: p.provider, label: p.label, configured: p.configured }));
    return NextResponse.json({ user, connections, templates, warehouse, canCreate, canCreatePersonal, oauthProviders });
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
    // The `warehouse` template is allowed ONLY when the operator enabled external
    // connectors; every other create is limited to the three working connectors so no
    // user can stand up a non-working mock connection through this surface.
    const isWarehouse = template === 'warehouse';
    if (isWarehouse && !config.externalConnectorsEnabled) {
      return NextResponse.json({ error: 'External-warehouse connectors are not enabled on this deployment' }, { status: 403 });
    }
    if (!isWarehouse && !isUserFacingTemplate(template)) {
      return NextResponse.json({ error: 'This connector is not available' }, { status: 400 });
    }
    // Parse + validate the warehouse block shape at the edge (the lib re-validates fields).
    let warehouse: WarehouseCreateInput | undefined;
    if (isWarehouse) {
      const w = body?.warehouse ?? {};
      const platform = String(w?.platform ?? '') as WarehousePlatform;
      if (!WAREHOUSE_PLATFORMS.includes(platform)) {
        return NextResponse.json({ error: 'A valid warehouse platform is required' }, { status: 400 });
      }
      const catalog = String(w?.catalog ?? '').trim();
      const rawFields = (w?.fields && typeof w.fields === 'object') ? (w.fields as Record<string, unknown>) : {};
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawFields)) fields[k] = String(v ?? '');
      warehouse = { platform, catalog, fields };
    }
    const conn = await createConnection(user, {
      name,
      template,
      endpoint: String(body?.endpoint ?? ''),
      credential: String(body?.credential ?? ''),
      domain: body?.domain ? String(body.domain) : undefined,
      openApiSpec: body?.openApiSpec,
      warehouse,
    });
    return NextResponse.json({ connection: conn }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
