/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { moveArtifactDomain, moveUnassignedToDomain, MOVABLE_KINDS } from '@/lib/platform-admin/domain-move';

export const dynamic = 'force-dynamic';

/** The kinds an admin can move (drives the UI's kind picker). Admin-gated. */
export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({ kinds: MOVABLE_KINDS });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Two admin-only, audited governance moves on one endpoint:
 *   • `{ op: 'bulk-unassigned', targetDomain }` — assign every UNASSIGNED
 *     artifact (empty/missing domain) to the target domain; returns per-kind counts.
 *   • `{ kind, id, targetDomain }` — move a single artifact's domain.
 * `adminCtx()` is the authoritative gate (401 anon / 403 non-admin); the
 * domain-move functions re-assert admin as defence-in-depth.
 */
export async function POST(req: Request) {
  try {
    const { user } = await adminCtx();
    const body = await req.json().catch(() => ({}));

    if (body?.op === 'bulk-unassigned') {
      const result = await moveUnassignedToDomain(user, String(body?.targetDomain ?? ''));
      return NextResponse.json(result);
    }

    const result = await moveArtifactDomain(user, {
      kind: String(body?.kind ?? ''),
      id: String(body?.id ?? ''),
      targetDomain: String(body?.targetDomain ?? ''),
    });
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
