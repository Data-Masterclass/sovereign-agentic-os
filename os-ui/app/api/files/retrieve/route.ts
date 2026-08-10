/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { filesRetrieve } from '@/lib/files/retrieve';

export const dynamic = 'force-dynamic';

/**
 * The governed `files_retrieve` tool endpoint. Runs under the signed-in user's
 * DELEGATED identity (DLS scopes the rows to what they may see); the OPA tool-grant
 * subject is derived SERVER-SIDE from that session, never from the client body — so
 * a client cannot elevate the tool-gate beyond what its session authorizes. This
 * mirrors /api/agent/tool, whose principal is a fixed server constant, not client
 * input. (A distinct agent runtime authenticates on its OWN path with its own
 * principal; it does not spoof one through this delegated-user endpoint.)
 *
 *   POST { query, openOriginal?, vision?, k? }
 *     → { decision, passages:[{name, snippet, deepLink, score, …}], traceId }
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { query?: string; openOriginal?: boolean; vision?: boolean; k?: number };
  const query = (body.query ?? '').toString().trim();
  if (!query) return NextResponse.json({ error: 'a query is required' }, { status: 400 });

  const result = await filesRetrieve({
    principal: { id: user.id, domains: user.domains },
    // Server-derived tool-grant subject: the session's own domain (the data spine
    // grants `files_retrieve` by domain). NOT client-supplied — filesRetrieve
    // defaults to principal.domains[0] ?? principal.id when grantSubject is omitted.
    query,
    k: body.k,
    openOriginal: body.openOriginal,
    visionFlag: body.vision,
  });
  return NextResponse.json(result, { status: result.decision === 'deny' ? 403 : 200 });
}
