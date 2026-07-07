/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { listDatasets, createDataset } from '@/lib/data/store';

export const dynamic = 'force-dynamic';

/** The dataset registry: GET lists tiles (grouped mine/domain/marketplace);
 *  `?archived=1` includes soft-archived datasets (for the Archived view).
 *  POST creates a new private dataset (a Bronze→Silver→Gold spine). */
export async function GET(req: Request) {
  try {
    const user = await requirePrincipal();
    const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
    return NextResponse.json(listDatasets(user, { includeArchived }));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const body = (await req.json().catch(() => ({}))) as { name?: string; domain?: string };
    if (!body.name || !body.name.trim()) {
      return NextResponse.json({ error: 'a dataset needs a name' }, { status: 400 });
    }
    const d = createDataset(user, { name: body.name, domain: body.domain });
    return NextResponse.json({ dataset: d }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
