/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { useAsKnowledge, useAsData } from '@tabs/files/lib/use-as';

export const dynamic = 'force-dynamic';

/**
 * "Use as" handoff: distil a file into Knowledge (tacit/doc) or Data (Bronze
 * dataset). POST { target: 'knowledge' | 'data' }. Returns the derived artifact's
 * handle so the UI can open the matching tab (lineage recorded in the files ring).
 */
export const POST = withRoute<{ id: string }, { target?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (body.target === 'knowledge') return NextResponse.json(await useAsKnowledge(id, user));
  if (body.target === 'data') return NextResponse.json(await useAsData(id, user));
  return NextResponse.json({ error: "target must be 'knowledge' or 'data'" }, { status: 400 });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
