/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { addSource, listSources, CONNECTOR_TEMPLATES, type Provider, type SyncMode, type SyncScope } from '@/lib/files/connectors';
import type { Sensitivity } from '@/lib/files/asset-schema';
import { requireUser } from '@/lib/core/auth';
import { getConnectionForUser } from '@/lib/connections';
import { providerForTemplate, filesProviderFor } from '@/lib/oauth/providers';

export const dynamic = 'force-dynamic';

/** Connected drives: GET lists the user's sources + the available Read templates;
 *  POST connects a new source (a folder or whole drive, copy or reference). */
export async function GET() {
  try {
    const user = await requirePrincipal();
    return NextResponse.json({ sources: listSources(user.id), templates: CONNECTOR_TEMPLATES });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as {
      provider?: Provider; label?: string; scope?: SyncScope; target?: string; mode?: SyncMode;
      domain?: string; connectionId?: string; landingSensitivity?: Sensitivity;
    };
    if (body.provider !== 'google-drive' && body.provider !== 'onedrive') {
      return NextResponse.json({ error: 'provider must be google-drive or onedrive' }, { status: 400 });
    }
    // Link to a governed Connection (the OAuth Read profile that holds the token).
    // Validate it belongs to the caller AND its provider matches this source, so a
    // source can never be pointed at someone else's credential or the wrong drive.
    let connectionId: string | null = null;
    if (body.connectionId) {
      const cu = await requireUser();
      const conn = await getConnectionForUser(body.connectionId, cu); // 404 if not visible
      if (conn.owner !== cu.id) {
        return NextResponse.json({ error: 'You can only link a connection you own' }, { status: 403 });
      }
      const connProvider = providerForTemplate(conn.template);
      if (!connProvider || filesProviderFor(connProvider) !== body.provider) {
        return NextResponse.json({ error: 'The linked connection does not match this drive provider' }, { status: 400 });
      }
      connectionId = conn.id;
    }
    const domain = body.domain && user.domains.includes(body.domain) ? body.domain : user.domains[0] ?? 'platform';
    const source = addSource({
      provider: body.provider,
      label: body.label?.trim() || (body.scope === 'drive' ? 'Whole drive' : 'Folder'),
      scope: body.scope === 'drive' ? 'drive' : 'folder',
      target: body.target?.trim() || 'root',
      mode: body.mode === 'reference' ? 'reference' : 'copy',
      owner: user.id,
      domain,
      connectionId,
      landingSensitivity: body.landingSensitivity,
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
