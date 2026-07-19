/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { previewFilesForApp } from '@/lib/software/apps';
import { readSdkSource } from '@/lib/software/app-sdk-vendor';
import { readUiSource } from '@/lib/software/app-ui-vendor';

export const dynamic = 'force-dynamic';

/**
 * Files for the Build/Preview "Instant preview" (in-browser esbuild-wasm bundler).
 * VIEW-gated (any user who can see the app), returns the app's CURRENT frontend
 * files PLUS the two vendored OS packages injected under `node_modules/` so the
 * bare imports resolve against the in-browser virtual FS:
 *   • `@sovereign-os/app-sdk` — `import { createOsClient } from '@sovereign-os/app-sdk'`
 *   • `@sovereign-os/ui`      — `import { AppShell } from '@sovereign-os/ui'`
 *                               + `import '@sovereign-os/ui/theme.css'`
 *
 *   GET /api/software/{id}/preview-files
 *     → { files, sdk, ui, template, mode }   (each of files/sdk/ui is {path,content}[])
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
    // Inject the SDK + design-system under node_modules so the bare imports resolve
    // in the in-browser bundler with no external registry / CDN egress.
    const sdk = readSdkSource('node_modules/@sovereign-os/app-sdk');
    const ui = readUiSource('node_modules/@sovereign-os/ui');
    return NextResponse.json({ files, sdk, ui, template, mode });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
