/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listAppsForUser } from '@/lib/apps';
import { getConnectionByApp } from '@/lib/infra/app-registry';

export const dynamic = 'force-dynamic';

/**
 * The auto-generated MCP connections surfaced in the Connections app (Software
 * golden path §4): every app the caller can see contributes its MCP connection +
 * governed tools, scoped by the same Personal/Shared/Marketplace visibility.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const apps = await listAppsForUser(user);
    const connections = apps
      .map((a) => {
        const c = getConnectionByApp(a.id);
        if (!c) return null;
        return {
          id: c.id,
          appId: a.id,
          appSlug: a.slug,
          name: c.name,
          principal: c.principal,
          owner: c.owner,
          domain: c.domain,
          visibility: a.visibility,
          tools: c.tools,
        };
      })
      .filter(Boolean);
    return NextResponse.json({ connections });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
