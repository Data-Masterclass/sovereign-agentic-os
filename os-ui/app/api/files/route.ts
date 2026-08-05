/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import type { CurrentUser } from '@/lib/core/auth';
import { requirePrincipal, errorResponse } from '@/lib/files/server';
import { listFiles, createFile, attachObject, objectKeyForAsset, type UploadInput } from '@/lib/files/store';
import { putBlob } from '@/lib/files/object-store';
import '@/lib/files/object-store-server'; // registers the durable MinIO backend
import { reindexFile } from '@/lib/files/pipeline-server';
import { truncationError } from '@/lib/files/integrity';
import { config } from '@/lib/core/config';
import type { Sensitivity, Storage } from '@/lib/files/asset-schema';
import { appSlugFromRequest, grantedIdSet } from '@/lib/software/app-origin';

export const dynamic = 'force-dynamic';

/** The file browser: GET lists the user's drive (mine/domain/marketplace + facets);
 *  POST uploads a new file into the governed object store (a private file at v1). */
export const GET = withRoute(async ({ user, req }) => {
  // ?archived=1 additionally returns soft-archived files (their own section), so an
  // archived file stays openable → its preview exposes Restore + Delete (OS-wide rule).
  const includeArchived = new URL(req.url).searchParams.get('archived') === '1';
  const groups = listFiles(user, { includeArchived });
  // LEAST-PRIVILEGE for app origins: narrow to (user access ∩ app grants); `facets`
  // (aggregate counts) is passed through. The OS UI is untouched (slug === null).
  const slug = appSlugFromRequest(req);
  if (slug) {
    const granted = await grantedIdSet(slug, 'files');
    const keep = <T extends { id: string }>(xs: T[]) => xs.filter((f) => granted.has(f.id));
    return NextResponse.json({ ...groups, mine: keep(groups.mine), domain: keep(groups.domain), marketplace: keep(groups.marketplace) });
  }
  return NextResponse.json(groups);
}, { gate: requirePrincipal as () => Promise<CurrentUser> });

/** True when a file's bytes should also be kept as indexable extracted text. */
function isTextLike(name: string, type: string): boolean {
  return /^text\//.test(type) || /json|csv|xml|markdown|yaml/.test(type) || /\.(txt|md|csv|tsv|json|log|xml|yaml|yml)$/i.test(name);
}

/**
 * SKIP (POST): multipart/formData + raw arrayBuffer — binary upload route.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal();
    const contentType = req.headers.get('content-type') ?? '';

    // ---- UI upload: multipart with the ORIGINAL bytes. Store them so Download
    //      returns the file byte-for-byte (not an empty/text stand-in). ----
    if (contentType.includes('multipart/form-data')) {
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
      const name = (String(form.get('name') ?? '') || file.name || 'upload').trim();
      const folder = String(form.get('folder') ?? '/') || '/';
      const tags = String(form.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const sensitivity = (form.get('sensitivity') as Sensitivity) || undefined;
      const bytes = Buffer.from(await file.arrayBuffer());
      const fileType = file.type || 'application/octet-stream';
      // Keep the extracted text for text-like files so search/indexing still works.
      const text = isTextLike(name, fileType) ? bytes.toString('utf8') : '';

      const asset = createFile(user, { name, folder, tags, sensitivity, text, bytes: bytes.length });
      // Persist the original bytes under the file's governed prefix, then record it.
      const key = objectKeyForAsset(asset);
      if (key) {
        await putBlob(key, bytes, fileType);
        attachObject(asset.id, user, { contentType: fileType, bytes: bytes.length });
      }
      await reindexFile(asset, text);
      return NextResponse.json({ asset }, { status: 201 });
    }

    // ---- UI upload (raw bytes): the browser POSTs the file as the RAW request
    //      body with `?upload=raw&name=&folder=` — read via arrayBuffer(), which is
    //      reliable for large bodies (Next/undici's formData() parser chokes on big
    //      multipart uploads). Same governed create + object-store put as above. ----
    if (new URL(req.url).searchParams.get('upload') === 'raw') {
      const sp = new URL(req.url).searchParams;
      const bytes = Buffer.from(await req.arrayBuffer());
      if (bytes.length === 0) {
        return NextResponse.json({ error: 'no file bytes received' }, { status: 400 });
      }
      // INTEGRITY GUARD: if the client declared a Content-Length, the body we read MUST
      // match it. A short read means the upload was truncated/aborted mid-stream (e.g.
      // an ingress 60s cut) — refuse to store corrupt bytes; surface a retryable error
      // instead of silently persisting a broken file.
      const incomplete = truncationError(bytes.length, req.headers.get('content-length'));
      if (incomplete) {
        return NextResponse.json({ error: incomplete }, { status: 400 });
      }
      const maxMb = Math.round(config.uploadMaxBytes / 1048576);
      if (bytes.length > config.uploadMaxBytes) {
        return NextResponse.json(
          { error: `file exceeds the ${maxMb} MB upload limit`, maxMb },
          { status: 413 },
        );
      }
      const name = (sp.get('name') || 'upload').trim();
      const folder = sp.get('folder') || '/';
      const tags = String(sp.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const sensitivity = (sp.get('sensitivity') as Sensitivity) || undefined;
      const fileType = contentType || 'application/octet-stream';
      const text = isTextLike(name, fileType) ? bytes.toString('utf8') : '';

      const asset = createFile(user, { name, folder, tags, sensitivity, text, bytes: bytes.length });
      const key = objectKeyForAsset(asset);
      if (key) {
        await putBlob(key, bytes, fileType);
        attachObject(asset.id, user, { contentType: fileType, bytes: bytes.length });
      }
      await reindexFile(asset, text);
      return NextResponse.json({ asset }, { status: 201 });
    }

    // ---- JSON upload: MCP `upload_file` / programmatic — extracted text only, no
    //      original bytes. Download serves that text (as .txt), never empty. ----
    const body = (await req.json().catch(() => ({}))) as Partial<UploadInput> & {
      name?: string; sensitivity?: Sensitivity; storage?: Storage;
    };
    if (!body.name || !body.name.trim()) {
      return NextResponse.json({ error: 'a file needs a name' }, { status: 400 });
    }
    const asset = createFile(user, {
      name: body.name,
      folder: body.folder,
      tags: body.tags,
      sensitivity: body.sensitivity,
      storage: body.storage,
      text: body.text,
      bytes: body.bytes,
      provenanceSource: body.provenanceSource,
      sourceUri: body.sourceUri,
    });
    // Auto-index: ingest-by-type → chunk+hash → embed → hybrid index (Processing →
    // Searchable ✓). Best-effort; the adapters self-fall-back to their mocks offline.
    await reindexFile(asset, body.text ?? '');
    return NextResponse.json({ asset }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
