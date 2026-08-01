/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { trace } from '@/lib/infra/agent-governed';
import { moveModel, ensureModelsHydrated, type Actor } from '@/lib/science';

export const dynamic = 'force-dynamic';

/** Map the platform Role onto the model-service Actor (human, never an agent). Preserve
 *  domain_admin so the shared edit-scope rule grants it in-domain manage rights. */
function actorFrom(user: { id: string; role: string; domains: string[] }): Actor {
  const role: Actor['role'] =
    user.role === 'admin' ? 'admin'
    : user.role === 'domain_admin' ? 'domain_admin'
    : user.role === 'builder' ? 'builder'
    : 'user';
  return { id: user.id, role, domains: user.domains, isAgent: false };
}

async function auth() {
  if (!config.mlEnabled) return { error: NextResponse.json({ error: 'Science (Layer 4) is off' }, { status: 404 }) };
  try {
    return { user: await requireUser() };
  } catch (e) {
    return { error: NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 }) };
  }
}

/**
 * Move a model into a folder. Runs AS the signed-in user; `moveModel` is edit-scoped in
 * the store (owner, in-domain domain_admin, or admin), so a viewer is rejected 403 and
 * nothing is written. The move also upserts an explicit folder row in the governed
 * registry (tab `'science'`, scope `'domain'` — models are domain-scoped), so the
 * destination folder persists even when empty. Mirrors POST /api/data/datasets/:id/folder.
 *
 *   POST /api/science/model/:model/folder  { folder }  → move the model
 */
export async function POST(req: Request, { params }: { params: Promise<{ model: string }> }) {
  const a = await auth();
  if (a.error) return a.error;
  const { model } = await params;
  let body: { folder?: string } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }
  if (typeof body.folder !== 'string') {
    return NextResponse.json({ error: 'a folder path is required' }, { status: 400 });
  }
  try {
    await ensureModelsHydrated(); // durable registry: act on the persisted state
    const m = moveModel(model, actorFrom(a.user!), body.folder); // 403 → nothing written
    await trace({ principal: a.user!.id, tool: 'model_move_folder', input: { model, folder: body.folder }, output: { folder: m.folder }, decision: 'allow' });
    return NextResponse.json({ ok: true, model: m });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
  }
}
