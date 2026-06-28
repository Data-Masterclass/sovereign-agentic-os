import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Lakehouse table list -> query-tool. The dedicated GET /tables endpoint isn't
 * exposed on this build, but every POST /query response carries the catalog's
 * available `tables`. So we run a trivial probe query and surface that list;
 * the Structured Data page reuses the same query box to preview each table.
 */
export async function GET() {
  try {
    const res = await fetch(`${config.queryToolUrl}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sql: 'select 1' }),
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `query-tool ${res.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const data = JSON.parse(text);
    const tables = Array.isArray(data?.tables) ? data.tables.map(String) : [];
    return NextResponse.json({ engine: data?.engine ?? 'duckdb', tables });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach query-tool: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
