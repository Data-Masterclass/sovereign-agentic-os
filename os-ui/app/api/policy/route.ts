import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Policy -> OPA. We read the `grants` data (principal -> allowed tools) to build
 * the universe of principals/tools, then live-verify every cell against the
 * decision API (`/v1/data/agentic/authz/allow`) so the matrix reflects the
 * actual default-deny decision engine, not just the raw data.
 */
async function decide(principal: string, tool: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.opaUrl}/v1/data/agentic/authz/allow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { principal, tool } }),
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.result);
  } catch {
    return false;
  }
}

export async function GET() {
  let grants: Record<string, string[]> = {};
  try {
    const res = await fetch(`${config.opaUrl}/v1/data/grants`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const raw = (data?.result ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      grants[k] = Array.isArray(v) ? v.map(String) : [];
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach OPA: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const principals = Object.keys(grants).sort();
  const tools = Array.from(new Set(Object.values(grants).flat())).sort();

  // Live-verify each (principal, tool) cell against the decision API.
  const cells = await Promise.all(
    principals.map(async (p) => ({
      principal: p,
      decisions: Object.fromEntries(
        await Promise.all(tools.map(async (t) => [t, await decide(p, t)] as const)),
      ) as Record<string, boolean>,
    })),
  );

  return NextResponse.json({ principals, tools, grants, matrix: cells });
}
