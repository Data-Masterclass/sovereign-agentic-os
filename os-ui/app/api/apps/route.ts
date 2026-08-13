/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { createApp, listAppsForUser, APP_TEMPLATES, type AppTemplateKey } from '@/lib/software/apps';
import type { SurfaceDeclaration } from '@/lib/software/model';
import { codedAppsEnabled } from '@/lib/platform-admin/settings';

export const dynamic = 'force-dynamic';

/** Apps visible to the caller (their Personal + their domain's Shared + Marketplace).
 *  Also surfaces ONLY the `codedAppsEnabled` platform flag (a single boolean — never
 *  the admin settings object) so the create launcher can decide whether to offer the
 *  coded path. Any authenticated user may read this one flag (os-ui 0.6.133). */
export const GET = withRoute(async ({ user }) => {
  const apps = await listAppsForUser(user);
  return NextResponse.json({ user, apps, templates: APP_TEMPLATES, codedAppsEnabled: codedAppsEnabled() });
}, { defaultStatus: 500 });

/**
 * New software: scaffold a per-app Forgejo repo, auto-generate its MCP +
 * Connection, register the app's data/files as Personal artifacts, and create
 * the app's page (home of record). One act = a governed connection + agent tool.
 */
export const POST = withRoute(async ({ user, req }) => {
  const body = await req.json();
  const name = String(body?.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'An app name is required' }, { status: 400 });
  // No template named → let createApp apply the ONE default (the Sovereign
  // standard app), so the UI and MCP front doors can never disagree on it.
  const template = body?.template ? (String(body.template) as AppTemplateKey) : undefined;
  const surfaceRaw = String(body?.surface ?? '').trim().toLowerCase();
  const surface: SurfaceDeclaration | undefined =
    surfaceRaw === 'ui' || surfaceRaw === 'api' || surfaceRaw === 'both' ? surfaceRaw : undefined;
  // AppSpec Phase 4a: a DECLARATIVE (spec) app skips the image pipeline and is served same-origin by
  // the OS renderer from its validated spec. Only the explicit 'spec' opts in; anything else is a
  // code app (the historic default), so the front door stays byte-stable for existing callers.
  const kind: 'spec' | 'code' = body?.kind === 'spec' ? 'spec' : 'code';
  const app = await createApp(user, {
    name,
    description: body?.description ? String(body.description) : '',
    template,
    domain: body?.domain ? String(body.domain) : undefined,
    surface,
    kind,
  });
  return NextResponse.json({ app }, { status: 201 });
}, { defaultStatus: 500 });
