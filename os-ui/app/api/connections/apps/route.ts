/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listAppsForUser } from '@/lib/software/apps';
import { getConnectionByApp } from '@/lib/infra/app-registry';

export const dynamic = 'force-dynamic';

/**
 * The auto-generated MCP connections surfaced in the Connections app (Software
 * golden path §4): every app the caller can see contributes its MCP connection +
 * governed tools, scoped by the same Personal/Shared/Marketplace visibility.
 */
export const GET = withRoute(async ({ user }) => {
    const apps = await listAppsForUser(user);
    const connections = apps
      // Archived apps have had their MCP grant + connection torn down; never
      // surface a connection for one (deleted apps are already gone from the list).
      .filter((a) => a.status !== 'archived')
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
}, { defaultStatus: 500 });
