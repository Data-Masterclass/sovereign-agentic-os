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
 * is checked against the `agent`/domain subject. An agent reaches this through the
 * runtime → os-ui governed path, exactly like /api/agent/tool.
 *
 *   POST { query, agent?, openOriginal?, vision?, k? }
 *     → { decision, passages:[{name, snippet, deepLink, score, …}], traceId }
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { query?: string; agent?: string; openOriginal?: boolean; vision?: boolean; k?: number };
  const query = (body.query ?? '').toString().trim();
  if (!query) return NextResponse.json({ error: 'a query is required' }, { status: 400 });

  const result = await filesRetrieve({
    principal: { id: user.id, domains: user.domains },
    grantSubject: body.agent, // an agent passes its principal; else the user's domain is used
    query,
    k: body.k,
    openOriginal: body.openOriginal,
    visionFlag: body.vision,
  });
  return NextResponse.json(result, { status: result.decision === 'deny' ? 403 : 200 });
}
