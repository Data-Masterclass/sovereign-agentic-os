/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@tabs/data/lib/server';
import { exportProject } from '@tabs/data/lib/dbt/read';

export const dynamic = 'force-dynamic';

/**
 * GET /api/data/projects/<domain>/export?ref=<sha|main> → the project at that commit as a tar
 * (`application/x-tar`). Binary body, so hand-rolled rather than `withRoute` (ARCHITECTURE.md).
 */
export async function GET(req: Request, ctx: { params: Promise<{ domain: string }> }) {
  try {
    const user = await requirePrincipal();
    const { domain } = await ctx.params;
    const ref = new URL(req.url).searchParams.get('ref') ?? undefined;
    const { filename, sha, tar } = await exportProject(domain, user, ref);
    return new NextResponse(new Uint8Array(tar), {
      status: 200,
      headers: {
        'Content-Type': 'application/x-tar',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-OS-Commit': sha,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
