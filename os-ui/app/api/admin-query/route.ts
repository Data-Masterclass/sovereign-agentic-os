/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/data/server';
import { queryRun } from '@/lib/governed';
import { cubeLoad, type CubeQuery } from '@/lib/governed';

export const dynamic = 'force-dynamic';

/**
 * Admin Query console — governed dual-engine endpoint.
 *
 * Mode "lakehouse": forward the SQL to the query-tool exactly as /api/query does,
 * but with the admin's own principal so Trino OPA applies the admin's broad
 * governed visibility (not a bypass — still through the OPA read path).
 *
 * Mode "cube": forward a Cube query JSON to `cubeLoad` (lib/governed), which
 * POSTs to Cube's `/cubejs-api/v1/load`. No security context is injected here
 * because the admin console is meant for exploring the semantic layer structure,
 * not impersonating a viewer region; the admin principal sees all governed members.
 *
 * NON-ADMINS CANNOT REACH THIS ROUTE: requireUser() checks session, and the role
 * gate below returns 403 immediately. The tab itself is also minRole:admin in the
 * sidebar so non-admin users never see the entry point.
 */
export async function POST(req: Request) {
  try {
    const u = await requireUser();

    // Fail-closed admin gate — defence in depth alongside the minRole nav guard.
    if (u.role !== 'admin') {
      return NextResponse.json({ error: 'admin role required' }, { status: 403 });
    }

    let body: { mode?: string; sql?: string; query?: CubeQuery };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const mode = (body?.mode ?? 'lakehouse').toString().trim();

    // ---- Lakehouse (Trino / Iceberg) ----------------------------------------
    if (mode === 'lakehouse') {
      const sql = (body?.sql ?? '').toString().trim();
      if (!sql) return NextResponse.json({ error: 'Missing sql' }, { status: 400 });

      // Admin principal: the admin's first domain (or their id for the personal lane).
      // Trino OPA governs based on this — broad admin visibility, not a policy bypass.
      const principal = u.domains[0] ?? u.id;
      const result = await queryRun(sql, principal);
      return NextResponse.json({ mode: 'lakehouse', ...result });
    }

    // ---- Cube (semantic layer) -----------------------------------------------
    if (mode === 'cube') {
      const cubeQuery = body?.query;
      if (!cubeQuery || typeof cubeQuery !== 'object') {
        return NextResponse.json(
          { error: 'Missing or invalid query object for Cube mode' },
          { status: 400 },
        );
      }
      const result = await cubeLoad(cubeQuery as CubeQuery);
      return NextResponse.json({ mode: 'cube', ...result });
    }

    return NextResponse.json({ error: `Unknown mode: ${mode}. Use "lakehouse" or "cube".` }, { status: 400 });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return errorResponse(e);
    return NextResponse.json(
      { error: `admin-query failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
