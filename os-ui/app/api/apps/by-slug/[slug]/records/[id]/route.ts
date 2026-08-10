/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getAppBySlugForUser } from '@/lib/software/apps';
import { RECORD_TOOLS, executeAppTool, recordActor } from '@/lib/software/app-records';

export const dynamic = 'force-dynamic';

/**
 * Get ONE of the deployed app's records by id — the read door for `os.records.get`.
 * Entry-gated (404 when the app is not visible to the caller); reads are always-on,
 * so no envelope check. Runs AS the signed-in user.
 */
export const GET = withRoute<{ slug: string; id: string }>(async ({ user, params }) => {
  const app = await getAppBySlugForUser(params.slug, user);
  if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });
  const result = await executeAppTool(app, RECORD_TOOLS.get, { id: params.id }, recordActor(user));
  return NextResponse.json({ result });
}, { defaultStatus: 500 });
