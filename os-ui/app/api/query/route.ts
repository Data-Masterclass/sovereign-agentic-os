import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Structured Data -> query-tool. The browser POSTs { sql }; we forward it to
 * the in-cluster query-tool's POST /query and return columns + rows.
 */
export async function POST(req: Request) {
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

  try {
    const res = await fetch(`${config.queryToolUrl}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sql }),
      cache: 'no-store',
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: `query-tool returned non-JSON: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    if (!res.ok || data.error) {
      return NextResponse.json(
        { error: (data.error as string) ?? `query-tool ${res.status}` },
        { status: res.ok ? 400 : 502 },
      );
    }
    return NextResponse.json({
      engine: data.engine ?? 'duckdb',
      tables: Array.isArray(data.tables) ? data.tables : [],
      columns: Array.isArray(data.columns) ? data.columns : [],
      rows: Array.isArray(data.rows) ? data.rows : [],
      rowCount: typeof data.row_count === 'number' ? data.row_count : 0,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach query-tool: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
