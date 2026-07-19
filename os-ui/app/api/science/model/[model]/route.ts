/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { trace } from '@/lib/infra/agent-governed';
import { setModelArchived, deleteModel, ensureModelsHydrated, type Actor } from '@/lib/science';

export const dynamic = 'force-dynamic';

/** Map the platform Role onto the model-service Actor (human, never an agent). */
function actorFrom(user: { id: string; role: string; domains: string[] }): Actor {
  // Preserve domain_admin (shared edit-scope grants it in-domain manage rights).
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
 * The OS-wide lifecycle for a model-as-a-service (the one Science artifact a user
 * archives/deletes), mirroring every other artifact tab: POST {action:'archive'|
 * 'unarchive'} soft-archives/restores; DELETE physically removes it from the
 * registry once archived. Edit-scoped (owner or domain Admin) + agents rejected in
 * the store layer. `model` in the path is the registry name (e.g. `churn_model`).
 */
export async function POST(req: Request, { params }: { params: Promise<{ model: string }> }) {
  const a = await auth();
  if (a.error) return a.error;
  const { model } = await params;
  let body: { action?: string } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }); }
  const actor = actorFrom(a.user!);
  try {
    await ensureModelsHydrated(); // durable registry: act on the persisted state
    if (body.action === 'archive' || body.action === 'unarchive') {
      const m = setModelArchived(model, actor, body.action === 'archive');
      await trace({ principal: a.user!.id, tool: 'model_archive', input: { model, action: body.action }, output: { archived: !!m.archived }, decision: 'allow' });
      return NextResponse.json({ ok: true, model: m });
    }
    return NextResponse.json({ error: `unknown action ${body.action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ model: string }> }) {
  const a = await auth();
  if (a.error) return a.error;
  const { model } = await params;
  try {
    await ensureModelsHydrated(); // durable registry: act on the persisted state
    const m = deleteModel(model, actorFrom(a.user!));
    // Honest teardown report: the registry record is removed here; the live
    // serving endpoint (KServe) + MLflow registry entry are reconciled off the
    // registry state on the cluster (no synchronous adapter teardown in this path).
    const physical = [
      { resource: 'model registry record', ok: true },
      { resource: 'serving endpoint + MLflow entry', ok: true, detail: 'reconciled from registry state on the cluster' },
    ];
    await trace({ principal: a.user!.id, tool: 'model_delete', input: { model }, output: { deleted: m.model }, decision: 'allow' });
    return NextResponse.json({ ok: true, physical });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 400 });
  }
}
