/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal } from '@/lib/files/server';
import { addVersion } from '@/lib/files/store';
import { reindexById } from '@/lib/files/pipeline-server';

export const dynamic = 'force-dynamic';

/** Re-upload a file → bump its content version (drag-drop versioning). */
export const POST = withRoute<{ id: string }, { text?: string; bytes?: number }>(async ({ user, params, body }) => {
  const { id } = params;
  const asset = addVersion(id, user, { text: body.text, bytes: body.bytes });
  await reindexById(id); // re-index only the changed chunks (content-hash cache)
  return NextResponse.json({ asset });
}, { parse: true, gate: requirePrincipal as () => Promise<CurrentUser> });
