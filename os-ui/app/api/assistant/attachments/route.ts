/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { config } from '@core/kernel/config';
import { authorize, uploadCreateDecision, type UploadCreateKind } from '@core/infra/governed';
import { attachmentWiring, routeAttachments, type IncomingAttachment } from '@core/runtime/chat-attachments-server';
import { ATTACHMENT_MAX_FILES, type Destination } from '@core/runtime/chat-attachments';
import { apiError } from '@core/kernel/route-server';
import { errorBodyOf } from '@core/kernel/server-message';

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
    if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      return apiError(400, 'Attach files as multipart/form-data (field "file").', 'upload.attachMultipartRequired');
    }
    // The whole message is capped at the single-upload limit, checked BEFORE the body is read, so
    // a request must say how large it is: a multipart body without Content-Length is refused.
    const lengthHeader = req.headers.get('content-length');
    const declared = lengthHeader === null ? NaN : Number(lengthHeader);
    if (!Number.isFinite(declared) || declared < 0) {
      return apiError(411, 'A Content-Length header is required to attach files.', 'upload.attachLengthRequired');
    }
    if (declared > config.uploadMaxBytes + 64 * 1024) {
      const maxMb = Math.round(config.uploadMaxBytes / 1048576);
      return apiError(413, `These files together exceed the ${maxMb} MB a message can carry. Nothing was uploaded.`, 'upload.attachTotalTooLarge', { maxMb });
    }
    const form = await req.formData();
    const parts = form.getAll('file').filter((f): f is File => f instanceof File);
    if (parts.length === 0) return apiError(400, 'No file was attached (multipart field "file").', 'upload.attachNoFile');
    let dests: unknown[] = [];
    try {
      const raw = JSON.parse(String(form.get('destinations') ?? '[]'));
      if (Array.isArray(raw)) dests = raw;
    } catch {
      return apiError(400, '"destinations" must be a JSON array.', 'upload.attachDestinationsInvalid');
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
      // The OPA create decision per file (never fails open), asked before the sink writes. The
      // full Authz goes back (policy: allow / deny / unreachable, decision id, policy revision),
      // so each file's audit record tells a refusal from an outage and names the decision.
      authorizeCreate: (u, destination) => authorize(`user:${u.id}`, 'upload.create', uploadCreateDecision(u, KIND[destination])),
    }, { totalMaxBytes: config.uploadMaxBytes });
    const status = out.refusedAll ? 400 : 200;
    return NextResponse.json(out, { status });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json(errorBodyOf(e), { status });
  }
}
