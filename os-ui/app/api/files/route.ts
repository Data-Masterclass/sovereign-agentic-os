/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute, apiError } from '@core/kernel/route-server';
import type { CurrentUser } from '@core/kernel/auth';
import { requirePrincipal, errorResponse } from '@tabs/files/lib/server';
import { listFiles, createFile, type UploadInput } from '@tabs/files/lib/store';
import { ingestUploaded } from '@tabs/files/lib/pipeline-server';
import { storeUploadedFile } from '@tabs/files/lib/upload-server';
import { authorize, uploadCreateDecision, uploadCreateRefusalBody } from '@core/infra/governed';
import { auditUploadCreateRefused } from '@/upload-create-audit';
import { truncationErrorBody } from '@tabs/files/lib/integrity';
import { config } from '@core/kernel/config';
import type { Sensitivity, Storage } from '@tabs/files/lib/asset-schema';
import { appSlugFromRequest, grantedIdSet } from '@tabs/software/lib/app-origin';

export const dynamic = 'force-dynamic';

/** The file browser: GET lists the user's drive (mine/domain/marketplace + facets);
 *  POST uploads a new file into the governed object store (a private file at v1). */
export const GET = withRoute(async ({ user, req }) => {
  // ?archived=1 additionally returns soft-archived files (their own section), so an
  // archived file stays openable → its preview exposes Restore + Delete (OS-wide rule).
  const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
  const groups = listFiles(user, { includeArchived });
  // LEAST-PRIVILEGE for app origins: narrow to (user access ∩ app grants). The folder and tag
  // rail (`facets`) is rebuilt from the rows the app keeps: the drive-wide one names the folders
  // and tags of files the app was never granted. The OS UI is untouched (slug === null).
  const slug = appSlugFromRequest(req);
  if (slug) {
    const granted = await grantedIdSet(slug, 'files');
    const keep = <T extends { id: string }>(xs: T[]) => xs.filter((f) => granted.has(f.id));
    const mine = keep(groups.mine);
    const domain = keep(groups.domain);
    const marketplace = keep(groups.marketplace);
    return NextResponse.json({ ...groups, mine, domain, marketplace, facets: facetsOfRows([...mine, ...domain, ...marketplace]) });
  }
  return NextResponse.json(groups);
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/** The folder and tag counts of exactly these rows (the shape `listFiles` returns as `facets`). */
function facetsOfRows(rows: { folder: string; tags: string[] }[]) {
  const folders = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const r of rows) {
    folders.set(r.folder, (folders.get(r.folder) ?? 0) + 1);
    for (const t of r.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  return {
    folders: [...folders.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
    tags: [...tags.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}

/**
 * SKIP (POST): multipart/formData + raw arrayBuffer — binary upload route.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const contentType = req.headers.get('content-type') ?? '';
    // Every branch below CREATES a private file: OPA decides first (`upload_create`, never fails open).
    const authz = await authorize(`user:${user.id}`, 'upload.create', uploadCreateDecision(user, 'file'));
    if (!authz.allowed) {
      auditUploadCreateRefused(user, 'file', 'POST /api/files', authz);
      return NextResponse.json(uploadCreateRefusalBody('file'), { status: 403 });
    }

    // ---- UI upload: multipart with the ORIGINAL bytes. Store them so Download
    //      returns the file byte-for-byte (not an empty/text stand-in). ----
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return apiError(400, 'a file is required (multipart field "file")', 'upload.fileRequired');
      }
      if (file.size > config.uploadMaxBytes) {
        const maxMb = Math.round(config.uploadMaxBytes / 1048576);
        return apiError(413, `file exceeds the ${maxMb} MB upload limit`, 'upload.tooLarge', { maxMb });
      }
      const name = (String(form.get('name') ?? '') || file.name || 'upload').trim();
      const folder = String(form.get('folder') ?? '/') || '/';
      const tags = String(form.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const sensitivity = (form.get('sensitivity') as Sensitivity) || undefined;
      const bytes = Buffer.from(await file.arrayBuffer());
      const stored = await storeUploadedFile(user, { name, folder, tags, sensitivity, bytes, contentType: file.type });
      return NextResponse.json({ asset: stored }, { status: 201 });
    }

    // ---- UI upload (raw bytes): the browser POSTs the file as the RAW request
    //      body with `?upload=raw&name=&folder=` — read via arrayBuffer(), which is
    //      reliable for large bodies (Next/undici's formData() parser chokes on big
    //      multipart uploads). Same governed create + object-store put as above. ----
    if (new URL(req.url).searchParams.get('upload') === 'raw') {
      const sp = new URL(req.url).searchParams;
      const bytes = Buffer.from(await req.arrayBuffer());
      if (bytes.length === 0) {
        return apiError(400, 'no file bytes received', 'upload.noBytes');
      }
      // INTEGRITY GUARD: if the client declared a Content-Length, the body we read MUST
      // match it. A short read means the upload was truncated/aborted mid-stream (e.g.
      // an ingress 60s cut) — refuse to store corrupt bytes; surface a retryable error
      // instead of silently persisting a broken file.
      const incomplete = truncationErrorBody(bytes.length, req.headers.get('content-length'));
      if (incomplete) {
        return NextResponse.json(incomplete, { status: 400 });
      }
      const maxMb = Math.round(config.uploadMaxBytes / 1048576);
      if (bytes.length > config.uploadMaxBytes) {
        return apiError(413, `file exceeds the ${maxMb} MB upload limit`, 'upload.tooLarge', { maxMb }, { maxMb });
      }
      const name = (sp.get('name') || 'upload').trim();
      const folder = sp.get('folder') || '/';
      const tags = String(sp.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const sensitivity = (sp.get('sensitivity') as Sensitivity) || undefined;
      const stored = await storeUploadedFile(user, { name, folder, tags, sensitivity, bytes, contentType });
      return NextResponse.json({ asset: stored }, { status: 201 });
    }

    // ---- JSON upload: MCP `upload_file` / programmatic — extracted text only, no
    //      original bytes. Download serves that text (as .txt), never empty. ----
    const body = (await req.json().catch(() => ({}))) as Partial<UploadInput> & {
      name?: string; sensitivity?: Sensitivity; storage?: Storage;
    };
    if (!body.name || !body.name.trim()) {
      return apiError(400, 'a file needs a name', 'files.nameRequired');
    }
    const asset = createFile(user, {
      name: body.name,
      folder: body.folder,
      tags: body.tags,
      description: body.description,
      sensitivity: body.sensitivity,
      storage: body.storage,
      text: body.text,
      bytes: body.bytes,
      provenanceSource: body.provenanceSource,
      sourceUri: body.sourceUri,
    });
    // Auto-index: ingest-by-type → chunk+hash → embed → hybrid index (Processing →
    // Searchable ✓). Best-effort; the adapters self-fall-back to their mocks offline.
    // A text upload then gets its description + tags written in the background (the uploader pays).
    const stored = await ingestUploaded(asset, body.text ?? '', user.id); // A27
    return NextResponse.json({ asset: stored }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
