/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { searchFiles } from '@tabs/files/lib/store';

export const dynamic = 'force-dynamic';

/** Search across the user's files — full-text + semantic-ish, DLS-scoped to what
 *  they may see, excluding stored-only (un-indexed) files. */
export const GET = withRoute(async ({ user, req }) => {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return NextResponse.json({ query: q, hits: searchFiles(user, q) });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
