import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/data/server';
import { queryRun } from '@/lib/governed';

export const dynamic = 'force-dynamic';

/**
 * Lakehouse table list -> governed query-tool (Trino). Runs `show tables` THROUGH
 * the governed path so the caller's principal reaches Trino's OPA plugin and the
 * listing is scoped to the caller's domain schema — no cross-domain mart recon.
 * Requires a session (401 for anon).
 */
export async function GET() {
  try {
    const u = await requireUser();
    const principal = u.domains[0] ?? u.id;
    const data = await queryRun('show tables', principal);
    const tables = data.rows.map((r) => String(r[0]));
    return NextResponse.json({ engine: data.engine ?? 'trino', tables });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return errorResponse(e);
    return NextResponse.json(
      { error: `Could not reach query-tool: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
