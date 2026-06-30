/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { searchFiles } from '@/lib/files/store';

export const dynamic = 'force-dynamic';

/** Search across the user's files — full-text + semantic-ish, DLS-scoped to what
 *  they may see, excluding stored-only (un-indexed) files. */
export async function GET(req: Request) {
  try {
    const user = await requirePrincipal();
    const q = new URL(req.url).searchParams.get('q') ?? '';
    return NextResponse.json({ query: q, hits: searchFiles(user, q) });
  } catch (e) {
    return errorResponse(e);
  }
}
