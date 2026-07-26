/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/files/server';
import { removeSource } from '@/lib/files/connectors';

export const dynamic = 'force-dynamic';

/** Disconnect a source (stops future syncs; already-imported files are kept). */
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const ok = removeSource(id, user.id);
  if (!ok) return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
