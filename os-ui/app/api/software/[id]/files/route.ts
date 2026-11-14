/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { listAppFiles, readAppFile, saveAppFile } from '@tabs/software/lib/apps';
import { pushAppFiles } from '@tabs/software/lib/push-app-files';

export const dynamic = 'force-dynamic';

/**
 * In-browser code editor backend for the Software golden path (Layer 3). Reads
 * and writes an app's source in its own governed file store (no git server):
 *
 *   GET  /api/software/{id}/files            → flat recursive file list (tree)
 *   GET  /api/software/{id}/files?path=a/b   → one file's content + blob SHA
 *   PUT  /api/software/{id}/files            → save ONE file (sha-checked, editor)
 *   POST /api/software/{id}/files            → PUSH a changeset (night-2 S6) — the UI twin of
 *                                              the MCP `push_app_files`, over the SAME service
 *                                              (`pushAppFiles`): compile gate before the write,
 *                                              one git commit in `apps/<slug>/`, `changed:false`
 *                                              and no commit when the bytes are identical.
 *
 * Builder/Admin-gated AND domain-scoped server-side (in lib/apps.ts), so the
 * role gate holds even if the UI is bypassed. A route is a SHELL: every gate, the compile
 * check and the git commit live in the governed library functions these three lines call.
 */

export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const path = new URL(req.url).searchParams.get('path');
  if (path) return NextResponse.json(await readAppFile(id, user, path));
  return NextResponse.json(await listAppFiles(id, user));
}, { defaultStatus: 500 });

export const PUT = withRoute<{ id: string }, { path?: string; content?: string; sha?: string; message?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  if (!body || typeof body.path !== 'string') {
    return NextResponse.json({ error: 'A file path is required.' }, { status: 400 });
  }
  const saved = await saveAppFile(id, user, {
    path: body.path,
    content: typeof body.content === 'string' ? body.content : '',
    sha: typeof body.sha === 'string' ? body.sha : '',
    message: typeof body.message === 'string' ? body.message : undefined,
  });
  return NextResponse.json(saved);
}, { parse: true, defaultStatus: 500 });

export const POST = withRoute<{ id: string }, { files?: { path: string; content: string }[]; message?: string }>(async ({ user, params, body }) => {
  const { id } = params;
  // The UI twin of the MCP `push_app_files` — the SAME service, so the parity test compares two
  // invocations of one function rather than two code paths that happen to agree today.
  const result = await pushAppFiles(
    {
      appId: id,
      files: Array.isArray(body?.files) ? body!.files! : [],
      message: typeof body?.message === 'string' ? body!.message : undefined,
      surface: 'ui:software/files',
    },
    user,
  );
  return NextResponse.json(result);
}, { parse: true, defaultStatus: 500 });
