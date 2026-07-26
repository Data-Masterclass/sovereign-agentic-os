/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/files/server';
import { searchFiles } from '@/lib/files/store';

export const dynamic = 'force-dynamic';

/** Search across the user's files — full-text + semantic-ish, DLS-scoped to what
 *  they may see, excluding stored-only (un-indexed) files. */
export const GET = withRoute(async ({ user, req }) => {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return NextResponse.json({ query: q, hits: searchFiles(user, q) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
