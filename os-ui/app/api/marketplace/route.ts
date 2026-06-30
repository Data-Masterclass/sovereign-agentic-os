/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { listingAdapter } from '@/lib/marketplace';
import { PRODUCT_TYPES, type ProductType, type ListingFilter } from '@/lib/marketplace';

export const dynamic = 'force-dynamic';

/**
 * Discovery: search/filter the cross-domain certified catalog.
 *   GET /api/marketplace?q=&type=&domain=&tag=&includeDeprecated=
 * Returns listings (with trust signals), the resolved adapter source, and the
 * caller (so the UI can hide "import" on the user's own-domain products).
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const typeParam = searchParams.get('type') as ProductType | null;
    const filter: ListingFilter = {
      q: searchParams.get('q') ?? undefined,
      type: typeParam && PRODUCT_TYPES.includes(typeParam) ? typeParam : undefined,
      domain: searchParams.get('domain') ?? undefined,
      tag: searchParams.get('tag') ?? undefined,
      includeDeprecated: searchParams.get('includeDeprecated') === 'true',
    };
    const items = await listingAdapter.list(filter);
    return NextResponse.json({
      user: { id: user.id, domains: user.domains, role: user.role },
      source: listingAdapter.source(),
      items,
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
