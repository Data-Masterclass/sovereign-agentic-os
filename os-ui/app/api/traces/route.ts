import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

type Trace = {
  id: string;
  name: string | null;
  input: unknown;
  output: unknown;
  timestamp: string | null;
  tags: string[];
};

/** Truncate any JSON-ish value to a short single-line preview for the table. */
function preview(v: unknown, max = 140): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Monitoring -> Langfuse. We call Langfuse's public API server-side with HTTP
 * basic auth (project-scoped keys live only on the server) and return a trimmed
 * list of recent agent traces.
 */
export async function GET() {
  const auth = Buffer.from(
    `${config.langfusePublicKey}:${config.langfuseSecretKey}`,
  ).toString('base64');

  try {
    const res = await fetch(`${config.langfuseUrl}/api/public/traces?limit=20`, {
      method: 'GET',
      headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Langfuse ${res.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = JSON.parse(text);
    const rows: Trace[] = (Array.isArray(data?.data) ? data.data : []).map(
      (t: Record<string, unknown>) => ({
        id: String(t.id ?? ''),
        name: (t.name as string) ?? null,
        input: preview(t.input),
        output: preview(t.output),
        timestamp: (t.timestamp as string) ?? null,
        tags: Array.isArray(t.tags) ? (t.tags as string[]) : [],
      }),
    );
    return NextResponse.json({ traces: rows });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach Langfuse: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
