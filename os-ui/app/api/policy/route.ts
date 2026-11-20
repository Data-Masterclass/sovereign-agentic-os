import { NextResponse } from 'next/server';
import { opaGetData, opaQuery } from '@core/adapters/opa/client';
import { requireAdmin } from '@core/kernel/auth';
import { errorResponse } from '@tabs/data/lib/server';

export const dynamic = 'force-dynamic';

/**
 * Policy -> OPA. We read the `grants` data (principal -> allowed tools) to build
 * the universe of principals/tools, then live-verify every cell against the
 * decision API (`/v1/data/agentic/authz/allow`) so the matrix reflects the
 * actual default-deny decision engine, not just the raw data.
 */
async function decide(principal: string, tool: string): Promise<boolean> {
  const r = await opaQuery('agentic/authz/allow', { principal, tool }, 5000);
  return r.ok && r.value.defined && Boolean(r.value.value);
}

export async function GET() {
  // The full grants/authorization matrix + every principal (participant email)
  // is a whole-tenant recon surface — admin-only. Non-admins get 403.
  try {
    await requireAdmin();
  } catch (e) {
    return errorResponse(e);
  }

  const grants: Record<string, string[]> = {};
  const read = await opaGetData('grants', 5000);
  if (!read.ok) {
    return NextResponse.json({ error: `Could not reach OPA: ${read.detail}` }, { status: 502 });
  }
  for (const [k, v] of Object.entries((read.value.value ?? {}) as Record<string, unknown>)) {
    grants[k] = Array.isArray(v) ? v.map(String) : [];
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
