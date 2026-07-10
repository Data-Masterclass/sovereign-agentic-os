/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { createApp, listAppsForUser, APP_TEMPLATES, type AppTemplateKey } from '@/lib/software/apps';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** Apps visible to the caller (their Personal + their domain's Shared + Marketplace). */
export async function GET() {
  try {
    const user = await requireUser();
    const apps = await listAppsForUser(user);
    return NextResponse.json({ user, apps, templates: APP_TEMPLATES });
  } catch (e) {
    return fail(e);
  }
}

/**
 * New software: scaffold a per-app Forgejo repo, auto-generate its MCP +
 * Connection, register the app's data/files as Personal artifacts, and create
 * the app's page (home of record). One act = a governed connection + agent tool.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json();
    const name = String(body?.name ?? '').trim();
    if (!name) return NextResponse.json({ error: 'An app name is required' }, { status: 400 });
    const template = String(body?.template ?? 'nextjs-supabase') as AppTemplateKey;
    const app = await createApp(user, {
      name,
      description: body?.description ? String(body.description) : '',
      template,
      domain: body?.domain ? String(body.domain) : undefined,
    });
    return NextResponse.json({ app }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
