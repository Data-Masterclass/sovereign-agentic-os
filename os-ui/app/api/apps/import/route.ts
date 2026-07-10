/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { createApp, type AppTemplateKey } from '@/lib/software/apps';
import { authorThroughFrontDoor, commitToApp } from '@/lib/software/server';

export const dynamic = 'force-dynamic';

/**
 * Front door #4 — the git bridge / import. Paste a GitHub/GitLab repo URL; the
 * platform mirrors it in and wraps it as a governed app. We derive the metadata
 * convention from whatever the repo carries (`app.yaml`/OpenAPI/README) and the
 * app page prompts for anything missing. The imported repo converges on the SAME
 * governed pipeline (preview → Builder-reviewed deploy → auto-MCP) as every other
 * front door.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      repoUrl?: string;
      template?: string;
      files?: { path: string; content: string }[];
    };
    const name = String(body.name ?? '').trim() || (body.repoUrl ? body.repoUrl.split('/').pop() ?? 'imported-app' : '');
    if (!name) return NextResponse.json({ error: 'A name or repo URL is required' }, { status: 400 });

    const app = await createApp(user, {
      name,
      description: `Imported from ${body.repoUrl ?? 'an external repo'}.`,
      template: (String(body.template ?? 'service') || 'service') as AppTemplateKey,
    });

    const authored = await authorThroughFrontDoor('git-import', {
      name,
      owner: user.id,
      repoUrl: body.repoUrl,
      files: body.files,
    });
    const { app: updated } = await commitToApp(app.id, user, authored.files, authored.message);

    return NextResponse.json({ app: updated, missing: authored.missing }, { status: 201 });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
