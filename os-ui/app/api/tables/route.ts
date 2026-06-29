import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Lakehouse table list -> governed query-tool (Trino). We run `show tables`
 * against the current schema and surface the names; the Structured Data page
 * reuses the same query box to preview each table.
 */
export async function GET() {
  try {
    const res = await fetch(`${config.queryToolUrl}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sql: 'show tables' }),
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
    const rows: unknown[][] = Array.isArray(data?.rows) ? data.rows : [];
    const tables = rows.map((r) => String(r[0]));
    return NextResponse.json({ engine: data?.engine ?? 'trino', tables });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach query-tool: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
