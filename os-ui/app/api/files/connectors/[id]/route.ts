/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute, apiError } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal } from '@tabs/files/lib/server';
import { removeSource, requireSourcesLoaded } from '@tabs/files/lib/connectors';

export const dynamic = 'force-dynamic';

/** Disconnect a source (stops future syncs; already-imported files are kept). */
export const DELETE = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  await requireSourcesLoaded();
  const ok = removeSource(id, user.id);
  if (!ok) return apiError(404, 'Source not found', 'files.sourceNotFound');
  return NextResponse.json({ ok: true });
}, { gate: requirePrincipal as () => Promise<CurrentUser> });
