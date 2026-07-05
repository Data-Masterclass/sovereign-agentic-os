/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { stepperStages } from '@/lib/data/panels';
import { ingestAndRegisterBronze } from '@/lib/data/ingest';

export const dynamic = 'force-dynamic';

/**
 * REAL Bronze ingest for a registry dataset (the guided "Upload a file"). The file is
 * streamed to MinIO under the caller's own `uploads/<uid>/` prefix, the data-runner
 * writes the physical `iceberg.personal_<uid>.bronze_<slug>` table, and ONLY when the
 * dlt adapter's apply+verify both pass is the Bronze version committed (the dot lit).
 * The principal is ALWAYS the session identity — the multipart body cannot supply one.
 * The guard→ingest→register flow itself is the SHARED `ingestAndRegisterBronze` (the
 * MCP `ingest_dataset` tool runs the exact same function); this route only owns the
 * multipart/size handling.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requirePrincipal();
    const { id } = await ctx.params;

    // Reject oversized uploads up-front (before buffering the multipart body).
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared && declared > config.uploadMaxBytes + 4096) {
      return NextResponse.json(
        { error: `file exceeds the ${Math.round(config.uploadMaxBytes / 1048576)} MB upload limit` },
        { status: 413 },
      );
    }
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'a file is required (multipart field "file")' }, { status: 400 });
    }
    if (file.size > config.uploadMaxBytes) {
      return NextResponse.json(
        { error: `file exceeds the ${Math.round(config.uploadMaxBytes / 1048576)} MB upload limit` },
        { status: 413 },
      );
    }
    const body = Buffer.from(await file.arrayBuffer());

    const r = await ingestAndRegisterBronze(user, id, file.name || 'upload.csv', body);
    if (!r.ok || !r.dataset) {
      // Verify did not pass → do NOT light the Bronze dot; surface the real error.
      return NextResponse.json({ ok: false, error: r.report.error ?? 'ingest verify failed', report: r.report }, { status: 502 });
    }
    return NextResponse.json({ ok: true, report: r.report, stages: stepperStages(r.dataset) });
  } catch (e) {
    return errorResponse(e);
  }
}
