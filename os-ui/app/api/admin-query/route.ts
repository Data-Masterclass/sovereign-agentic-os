/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { errorResponse } from '@/lib/data/server';
import { queryRun } from '@/lib/infra/governed';
import { cubeLoad, type CubeQuery } from '@/lib/infra/governed';

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
 * ACCESS: builder+. The query runs with the CALLER's own principal, so Trino OPA
 * / RLS governs exactly what this user may read — a builder sees only their own
 * governed visibility, never a bypass. requireUser() checks session and the role
 * gate below returns 403 for creators. The Console tab is builder+ in the sidebar;
 * the raw Shell sub-surface (arbitrary command execution) stays admin-only and is
 * gated separately (ConsoleClient + the terminal broker), not here.
 */
export async function POST(req: Request) {
  try {
    const u = await requireUser();

    // Fail-closed gate — builder+ for the governed query surface; defence in depth
    // alongside the minRole nav guard. Creators file requests, they don't query here.
    if (!roleAtLeast(u.role, 'builder')) {
      return NextResponse.json({ error: 'builder role required' }, { status: 403 });
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
      // The raw Cube branch runs UNSCOPED (no per-viewer securityContext — it is
      // meant for an admin exploring the semantic-layer structure, seeing all
      // governed members). That would leak rows to a builder, so Cube mode stays
      // admin-only. Builders use Lakehouse SQL, which runs under their own Trino
      // OPA principal. (The governed per-viewer metric path is the Metrics tab.)
      if (u.role !== 'admin') {
        return NextResponse.json({ error: 'Cube semantic-layer mode is admin-only; use Lakehouse SQL for governed per-caller queries' }, { status: 403 });
      }
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
