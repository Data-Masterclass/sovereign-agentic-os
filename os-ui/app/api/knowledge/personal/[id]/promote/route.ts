/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { roleAtLeast } from '@/lib/core/session';
import { getPersonalKnowledge, ensureHydrated } from '@/lib/knowledge/personal-store';
import {
  promoteThroughSeam,
  fileArtifactPromotion,
  fileArtifactCertification,
} from '@/lib/governance/ladder';

export const dynamic = 'force-dynamic';

/**
 * Promote a personal ("My knowledge") entry along the governed ladder — the SAME
 * seam every other artifact rides (`lib/governance/ladder.ts`), keyed on the
 * `personal_knowledge` kind.
 *
 * Personal → Shared: a domain_admin+ promotes in one shot; a creator/builder (owner,
 *   no promote rights) FILES request_promotion (docs-first) for a domain admin to
 *   approve — a builder PROPOSES their own entry, it is not self-approved.
 * Shared → Marketplace: an Admin certifies in one shot; a Builder/Domain-admin
 *   files a certification request for a platform Admin to approve.
 *
 * The rung is derived from the entry's current tier — never a silent jump.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
    const { id } = params;
    const entry = getPersonalKnowledge(id, user); // view-gate + current tier

    // Personal → Shared (rung 1). domain_admin+ one-shots; a creator/builder files a
    // request (the OWNER proposes their own entry; a domain admin approves).
    if (entry.visibility === 'Personal') {
      if (roleAtLeast(user.role, 'domain_admin')) {
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
}, { hydrate: ensureHydrated, defaultStatus: 500 });
