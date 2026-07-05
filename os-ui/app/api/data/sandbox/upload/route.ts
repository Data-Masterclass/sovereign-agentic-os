/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { ingestUpload } from '@/lib/data/ingest';

export const dynamic = 'force-dynamic';

/**
 * Personal-lane REAL upload. Replaces the former in-process preview Map: the file is
 * streamed to MinIO under the caller's own `uploads/<uid>/` prefix and the data-runner
 * writes a PHYSICAL `iceberg.personal_<uid>.bronze_<slug>` table — so personal uploads
 * SURVIVE restarts and are queryable through the governed path. The principal is ALWAYS
 * the session identity; the multipart body cannot supply one.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  try {
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared && declared > config.uploadMaxBytes + 4096) {
      return NextResponse.json(
        { error: `file exceeds the ${Math.round(config.uploadMaxBytes / 1048576)} MB upload limit` },
        { status: 413 },
      );
    }
    const form = await req.formData();
    const file = form.get('file');
    const name = String(form.get('name') ?? '').trim();
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
    const report = await ingestUpload({
      principal: user.id, // session-bound — never the request body
      datasetName: name || file.name || 'upload',
      fileName: file.name || 'upload.csv',
      body,
    });
    if (!report.ok) {
      return NextResponse.json({ ok: false, error: report.error ?? 'ingest verify failed', report }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      dataset: { id: report.table, name: name || file.name, origin: 'upload', columns: report.columns.map((c) => c.name), rowCount: report.rowCount },
      report,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
