/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { createApp, listAppsForUser, APP_TEMPLATES, type AppTemplateKey } from '@/lib/software/apps';
import type { SurfaceDeclaration } from '@/lib/software/model';

export const dynamic = 'force-dynamic';

/** Apps visible to the caller (their Personal + their domain's Shared + Marketplace). */
export const GET = withRoute(async ({ user }) => {
  const apps = await listAppsForUser(user);
  return NextResponse.json({ user, apps, templates: APP_TEMPLATES });
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
  const app = await createApp(user, {
    name,
    description: body?.description ? String(body.description) : '',
    template,
    domain: body?.domain ? String(body.domain) : undefined,
    surface,
  });
  return NextResponse.json({ app }, { status: 201 });
}, { defaultStatus: 500 });
