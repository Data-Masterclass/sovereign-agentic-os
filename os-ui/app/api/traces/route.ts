import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/data/server';

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

/** The principal a trace was recorded under (governed traces stamp it in metadata). */
function tracePrincipal(t: Record<string, unknown>): string {
  const md = (t.metadata ?? {}) as Record<string, unknown>;
  return String(md.principal ?? '');
}

/**
 * Monitoring -> Langfuse. We call Langfuse's public API server-side with HTTP
 * basic auth (project-scoped keys live only on the server) and return a trimmed
 * list of recent agent traces. Requires a session (401 for anon) and is SCOPED
 * to the caller: an admin sees every trace; anyone else sees only traces recorded
 * under their own identity (id) or one of their domains — tool I/O never leaks
 * across users/domains.
 */
export async function GET() {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return errorResponse(e);
  }
  const isAdmin = u.role === 'admin';
  const mine = new Set<string>([u.id, ...u.domains]);

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
    const raw: Record<string, unknown>[] = Array.isArray(data?.data) ? data.data : [];
    // Non-admins: keep only traces recorded under the caller's id/domain (drop
    // unlabeled ones — fail closed, never leak another user's tool I/O).
    const visible = isAdmin ? raw : raw.filter((t) => mine.has(tracePrincipal(t)));
    const rows: Trace[] = visible.map((t) => ({
      id: String(t.id ?? ''),
      name: (t.name as string) ?? null,
      input: preview(t.input),
      output: preview(t.output),
      timestamp: (t.timestamp as string) ?? null,
      tags: Array.isArray(t.tags) ? (t.tags as string[]) : [],
    }));
    return NextResponse.json({ traces: rows });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach Langfuse: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
