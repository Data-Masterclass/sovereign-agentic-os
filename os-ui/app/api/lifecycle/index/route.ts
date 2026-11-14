/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { lifecycleIndex } from '@core/infra/lifecycle-pins';
import { isLifecycleKind, lifecycleOf, lifecycleWordOf } from '@core/kernel/object-lifecycle';

export const dynamic = 'force-dynamic';

/** How many ids one tile list may ask about — a page of tiles, generously. */
const MAX_IDS = 500;

/**
 * POST /api/lifecycle/index { kind, ids } → { lifecycle: { [id]: 'draft'|'testing'|'live' } }
 *
 * The lookup every tile list needs: which of THESE ids are live. The caller sends the ids it is
 * already holding, so the answer discloses nothing it could not already see — unlike returning
 * the whole pin index, which would leak the existence of objects the caller cannot read.
 *
 * Read-only and cheap: it reads the hydrated pin index and maps words. No store is touched, so a
 * list of a hundred tiles costs one request and no per-object resolution.
 */
export const POST = withRoute<Record<string, string>, { kind?: string; ids?: unknown }>(
  async ({ body }) => {
    const kind = String(body?.kind ?? '').trim();
    if (!isLifecycleKind(kind)) {
      return NextResponse.json({ error: `unknown kind: "${kind}"` }, { status: 400 });
    }
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, MAX_IDS)
      : [];
    const index = await lifecycleIndex();
    const lifecycle: Record<string, string> = {};
    for (const id of ids) {
      lifecycle[id] = lifecycleWordOf(lifecycleOf(kind, id, 'unversioned', index));
    }
    return NextResponse.json({ kind, lifecycle });
  },
  { parse: true, defaultStatus: 500 },
);
