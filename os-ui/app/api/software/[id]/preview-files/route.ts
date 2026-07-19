/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { previewFilesForApp } from '@/lib/software/apps';
import { readSdkSource } from '@/lib/software/app-sdk-vendor';

export const dynamic = 'force-dynamic';

/**
 * Files for the Build/Preview "Instant preview" (browser Sandpack). VIEW-gated
 * (any user who can see the app), returns the app's CURRENT frontend files plus
 * the OS-client SDK source injected under `node_modules/@sovereign-os/app-sdk/`
 * so `import { createOsClient } from '@sovereign-os/app-sdk'` resolves in-browser.
 *
 *   GET /api/software/{id}/preview-files
 *     → { files: {path, content}[], sdk: {path, content}[], template, mode }
 *
 * No Forgejo credential ever reaches the browser: the server reads the repo (or
 * the committed snapshot/template fallback) and returns decoded text. The preview
 * calls the OS same-origin AS the signed-in user, so governance still decides what
 * data renders — this route only ships the source, never any granted data.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const { files, template, mode } = await previewFilesForApp(id, user);
    // Inject the SDK under node_modules so the bare import resolves in Sandpack.
    const sdk = readSdkSource('node_modules/@sovereign-os/app-sdk');
    return NextResponse.json({ files, sdk, template, mode });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
