/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { listForUser, listMarketplace } from '@/lib/core/artifacts';
import { ARTIFACT_TYPES, type ArtifactType } from '@/lib/core/artifact-model';

export const dynamic = 'force-dynamic';

/**
 * Marketplace: cross-domain Certified catalog. Also returns the set of source
 * ids the caller has already added, so the UI can show "Added" instead of "Add".
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const typeParam = searchParams.get('type') as ArtifactType | null;
    const items = await listMarketplace({
      type: typeParam && ARTIFACT_TYPES.includes(typeParam) ? typeParam : undefined,
    });
    const mine = await listForUser(user);
    const added = mine
      .filter((a) => a.origin === 'certified-copy' && a.sourceId)
      .map((a) => a.sourceId as string);
    return NextResponse.json({ user, items, added });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
