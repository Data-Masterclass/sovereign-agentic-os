/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getAppBySlugForUser } from '@/lib/software/apps';
import {
  RECORD_TOOLS,
  envelopeAllowsRecordTool,
  executeAppTool,
} from '@/lib/software/app-records';

export const dynamic = 'force-dynamic';

/**
 * Export the deployed app's records to a file — the write door for `os.records.export`.
 * Entry-gated (404) AND envelope-gated (403 unless a Builder approved `export_records`
 * in the deploy envelope). A static segment, so it never collides with `/records/[id]`.
 * Runs AS the signed-in user.
 */
export const POST = withRoute<{ slug: string }>(async ({ user, params }) => {
  const app = await getAppBySlugForUser(params.slug, user);
  if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });
  const gate = envelopeAllowsRecordTool(app, RECORD_TOOLS.export);
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 403 });
  const result = await executeAppTool(app, RECORD_TOOLS.export);
  return NextResponse.json({ result });
}, { defaultStatus: 500 });
