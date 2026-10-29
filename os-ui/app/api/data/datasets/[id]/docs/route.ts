/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/data/lib/server';
import { setDocs } from '@tabs/data/lib/store';
import { transparencyGate } from '@tabs/data/lib/transparency';
import type { ColumnDoc } from '@tabs/data/lib/index';

export const dynamic = 'force-dynamic';

/**
 * The documentation form (data-tab-deep-design.md §Trust). Writes the description +
 * column descriptions into dataset.yaml, and returns the live transparency-gate
 * status so the UI can show exactly what is still missing before promotion.
 */
export const POST = withRoute<{ id: string }, { description?: string; columns?: ColumnDoc[] }>(async ({ user, params, body }) => {
  const { id } = params;
  const dataset = setDocs(id, user, { description: body.description, columns: body.columns });
  return NextResponse.json({ dataset, gate: transparencyGate(dataset) });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
