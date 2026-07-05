/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { buildCatalog } from '@/lib/agents/tool-catalog';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agents/tool-catalog
 *
 * Returns the MCP tools the SESSION user may grant to an agent system, scoped by
 * the user's own role so they can never grant above their own floor. Principal is
 * always taken from the session — never from the request body.
 *
 * Response: `{ tools: CatalogEntry[] }` where each entry carries
 *   `{ name, tab, minRole, description, requires_approval }`.
 */
export async function GET() {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as { status?: number }).status ?? 401 },
    );
  }
  return NextResponse.json({ tools: buildCatalog(user.role) });
}
