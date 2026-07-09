/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listSystems, createSystem, ensureHydrated, markPendingShares } from '@/lib/agents/store';
import { isTemplateKey } from '@/lib/agents/templates';
import { listApprovals } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** The ids of agent systems with a Personal→Shared promotion pending in the queue
 *  (owner filed `request_promotion`; a Builder/Admin has not yet approved). Used to
 *  honestly badge those systems as "pending share approval" in the list. */
function pendingShareIds(): Set<string> {
  const ids = new Set<string>();
  for (const a of listApprovals({ status: 'pending' })) {
    if (a.kind === 'artifact_promote' && a.payload?.artifactKind === 'agent_system' && typeof a.payload?.id === 'string') {
      ids.add(a.payload.id);
    }
  }
  return ids;
}

/** GET → the caller's systems grouped Mine / My domain / Marketplace.
 *  `?archived=1` includes soft-archived systems (for the Archived view). */
export async function GET(req: Request) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
    return NextResponse.json(markPendingShares(listSystems(user, { includeArchived }), pendingShareIds()));
  } catch (e) {
    return fail(e);
  }
}

/** POST → create a new system (lands under Mine). */
export async function POST(req: Request) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name.trim()) return NextResponse.json({ error: 'A system name is required.' }, { status: 400 });
    // Security: visibility is NOT accepted from the client — a new system is
    // always Personal. Sharing/publishing is the governed `promoteSystem` ladder.
    const rec = createSystem(user, {
      name,
      domain: typeof body.domain === 'string' ? body.domain : undefined,
      // A server-authored template only (validated key) — never client yaml.
      template: isTemplateKey(body.template) ? body.template : undefined,
    });
    return NextResponse.json({ id: rec.id });
  } catch (e) {
    return fail(e);
  }
}
