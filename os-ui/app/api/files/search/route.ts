/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { searchFilesHybrid } from '@tabs/files/lib/search';

export const dynamic = 'force-dynamic';

/** Search across the user's files — hybrid (BM25 + k-NN over the `files` index, fused), DLS-scoped
 *  to what they may see, excluding stored-only (un-indexed) files. `mode`/`note` say when it fell
 *  back to the keyword scan. */
export const GET = withRoute(async ({ user, req }) => {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return NextResponse.json(await searchFilesHybrid(user, q));
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
