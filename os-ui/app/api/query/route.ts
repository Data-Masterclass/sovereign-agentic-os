import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/data/server';
import { queryRun } from '@/lib/governed';
import { readPrincipalFor } from '@/lib/data/store-fqn';

export const dynamic = 'force-dynamic';

/**
 * Structured Data -> governed query-tool. The browser POSTs { sql }; we forward it
 * through the SAME governed path an agent uses (`queryRun`) so the caller's
 * principal reaches Trino's OPA plugin and rows/columns are scoped to the right
 * domain identity. Requires a session (401 for anon); a student can never read
 * across domains because the principal — not the client — decides what Trino returns.
 */
export async function POST(req: Request) {
  try {
    const u = await requireUser();
    let sql = '';
    try {
      const body = await req.json();
      sql = (body?.sql ?? '').toString().trim();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!sql) {
      return NextResponse.json({ error: 'Missing SQL' }, { status: 400 });
    }

    // The principal Trino's OPA plugin governs row/column on. Owner-aware: a read that
    // touches the caller's OWN `personal_<uid>` lane runs AS the owner (that schema is
    // owner-only under OPA `is_owned_personal`, so the domain principal is denied — even
    // for the owner's own table); every other read runs as the caller's domain. Derived
    // SERVER-SIDE from the session + SQL — never trusted from the request body.
    const principal = readPrincipalFor(sql, u);
    const result = await queryRun(sql, principal);
    return NextResponse.json(result);
  } catch (e) {
    // 401 for anon (thrown by requireUser); otherwise surface a 400/502.
    const status = (e as { status?: number }).status;
    if (status) return errorResponse(e);
    return NextResponse.json(
      { error: `query failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
