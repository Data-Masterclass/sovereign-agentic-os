/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { getPersonalKnowledge, ensureHydrated } from '@/lib/knowledge/personal-store';
import {
  promoteThroughSeam,
  fileArtifactPromotion,
  fileArtifactCertification,
} from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

type Params = { params: Promise<{ id: string }> };

/**
 * Promote a personal ("My knowledge") entry along the governed ladder — the SAME
 * seam every other artifact rides (`lib/governance/ladder.ts`), keyed on the
 * `personal_knowledge` kind.
 *
 * Personal → Shared: a Builder+ promotes in one shot; a creator (owner, no
 *   promote rights) FILES request_promotion (docs-first) for a Builder to approve.
 * Shared → Marketplace: an Admin certifies in one shot; a Builder/Domain-admin
 *   files a certification request for a platform Admin to approve.
 *
 * The rung is derived from the entry's current tier — never a silent jump.
 */
export async function POST(_req: Request, { params }: Params) {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const { id } = await params;
    const entry = getPersonalKnowledge(id, user); // view-gate + current tier

    // Personal → Shared (rung 1). Builder+ one-shots; a creator files a request.
    if (entry.visibility === 'Personal') {
      if (roleAtLeast(user.role, 'builder')) {
        const r = await promoteThroughSeam('personal_knowledge', id, user, { rung: 'promote' });
        return NextResponse.json({ ok: r.ok, visibility: r.artifact.visibility, applied: r.applied });
      }
      const approval = await fileArtifactPromotion('personal_knowledge', id, user);
      return NextResponse.json({ requested: true, approval });
    }

    // Shared → Marketplace (rung 2). Admin one-shots; lower roles file a request.
    if (entry.visibility === 'Shared') {
      if (roleAtLeast(user.role, 'admin')) {
        const r = await promoteThroughSeam('personal_knowledge', id, user, { rung: 'certify' });
        return NextResponse.json({ ok: r.ok, visibility: r.artifact.visibility, applied: r.applied });
      }
      const approval = await fileArtifactCertification('personal_knowledge', id, user);
      return NextResponse.json({ requested: true, approval });
    }

    return NextResponse.json({ error: 'This knowledge is already certified.' }, { status: 409 });
  } catch (e) {
    return fail(e);
  }
}
