/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { authorize, uploadCreateDecision, type UploadCreateKind } from '@core/infra/governed';
import { attachmentWiring, routeAttachments, type IncomingAttachment } from '@core/runtime/chat-attachments-server';
import { ATTACHMENT_MAX_FILES, type Destination } from '@core/runtime/chat-attachments';

export const dynamic = 'force-dynamic';

const KIND: Record<Destination, UploadCreateKind> = { data: 'dataset', files: 'file', knowledge: 'knowledge' };

/**
 * POST (multipart): the files attached to one chat message. Fields: `file` (repeated, at most
 * ATTACHMENT_MAX_FILES) and `destinations`, a JSON array aligned with the files ('data' | 'files' |
 * 'knowledge' | null for the sniffed default). Each file is sniffed, policy-checked (OPA
 * `upload_create`), written to the caller's My scope by the owning tab's service, and audited —
 * all in `routeAttachments`; this handler only reads the request.
 *
 * SKIP (POST): multipart/formData — binary upload route.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    // The whole message is capped at the single-upload limit, checked before the body is read.
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared && declared > config.uploadMaxBytes + 64 * 1024) {
      return NextResponse.json(
        { error: `These files together exceed the ${Math.round(config.uploadMaxBytes / 1048576)} MB a message can carry. Nothing was uploaded.` },
        { status: 413 },
      );
    }
    if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      return NextResponse.json({ error: 'Attach files as multipart/form-data (field "file").' }, { status: 400 });
    }
    const form = await req.formData();
    const parts = form.getAll('file').filter((f): f is File => f instanceof File);
    if (parts.length === 0) return NextResponse.json({ error: 'No file was attached (multipart field "file").' }, { status: 400 });
    let dests: unknown[] = [];
    try {
      const raw = JSON.parse(String(form.get('destinations') ?? '[]'));
      if (Array.isArray(raw)) dests = raw;
    } catch {
      return NextResponse.json({ error: '"destinations" must be a JSON array.' }, { status: 400 });
    }
    // Over the count: no bytes are read at all; routeAttachments refuses (and audits) every file.
    const files: IncomingAttachment[] = await Promise.all(parts.map(async (f, i) => ({
      name: f.name,
      bytes: parts.length > ATTACHMENT_MAX_FILES ? Buffer.alloc(0) : Buffer.from(await f.arrayBuffer()),
      destination: dests[i] ?? undefined,
    })));
    const wiring = attachmentWiring();
    const out = await routeAttachments(user, files, {
      ...wiring,
      // The OPA create decision per file (never fails open), asked before the sink writes.
      authorizeCreate: (u, destination) => authorize(`user:${u.id}`, 'upload.create', uploadCreateDecision(u, KIND[destination])),
    }, { totalMaxBytes: config.uploadMaxBytes });
    const status = out.refusedAll ? 400 : 200;
    return NextResponse.json(out, { status });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
