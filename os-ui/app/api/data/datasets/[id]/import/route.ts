/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/experimental/data/server';
import { importProduct } from '@/lib/experimental/data/store';

export const dynamic = 'force-dynamic';

/**
 * Import / subscribe to a marketplace data product from another domain. Records the
 * importing domain + adds the read grant the policy compiler turns into OPA access.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const product = importProduct(id, user);
  return NextResponse.json({ dataset: product });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
