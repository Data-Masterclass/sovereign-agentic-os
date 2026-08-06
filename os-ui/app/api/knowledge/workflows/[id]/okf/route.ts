/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { makeRequirePrincipal, errorResponse } from '@/lib/core/route-server';
import { getWorkflow, ensureHydrated } from '@/lib/knowledge/store';
import { exportWorkflowBundle } from '@/lib/knowledge/okf-export';
import { zipBundle } from '@/lib/knowledge/okf-zip';

export const dynamic = 'force-dynamic';

const requirePrincipal = makeRequirePrincipal(ensureHydrated);

/**
 * GET /api/knowledge/workflows/[id]/okf
 *
 * Export the business process as an OKF v0.2 bundle (zip download). Governance: the
 * `getWorkflow(id, user)` canView / DLS check runs first — only a principal who may
 * SEE the process may export it; a non-viewer gets the store's 403/404 and the route
 * never reveals whether the process exists. Server-only zip (node:zlib in okf-zip).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;
    const view = getWorkflow(id, user); // canView gate
    const bundle = exportWorkflowBundle(view);
    const zip = zipBundle(bundle);
    const name = `${slug(view.title) || 'workflow'}.okf.zip`;
    return new NextResponse(zip as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': String(zip.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
