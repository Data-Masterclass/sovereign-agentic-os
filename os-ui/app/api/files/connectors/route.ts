/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { addSource, listSources, CONNECTOR_TEMPLATES, type Provider, type SyncMode, type SyncScope } from '@/lib/files/connectors';
import type { Sensitivity } from '@/lib/files/asset-schema';

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
      domain?: string; landingSensitivity?: Sensitivity;
    };
    if (body.provider !== 'google-drive' && body.provider !== 'onedrive') {
      return NextResponse.json({ error: 'provider must be google-drive or onedrive' }, { status: 400 });
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
      landingSensitivity: body.landingSensitivity,
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
