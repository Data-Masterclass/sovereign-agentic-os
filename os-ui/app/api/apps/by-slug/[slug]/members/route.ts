/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import {
  getAppBySlugForUser,
  listAppMembers,
  addAppMember,
  removeAppMember,
  type AppMemberRole,
} from '@/lib/software/apps';

export const dynamic = 'force-dynamic';

/**
 * The deployed app's OWN membership — keyed by the frozen `slug` the app has baked
 * in (`APP_SLUG`), since the deployed app never knows the OS app id. Runs AS the
 * signed-in OS user.
 *
 * This is the app's ADMIN model, NOT the domain directory: the OWNER (implicit
 * admin) plus any users explicitly added to THIS app. It replaces the old "whole
 * domain directory" list that surfaced every cohort account. It does NOT gate ENTRY
 * to the app — identity stays delegated to the OS session, domain-wide.
 *
 *   GET    → the app's membership (owner + explicit members) + whether you may manage it
 *   POST   { userId, role? }  → add/re-role a member (edit-scoped: owner / in-domain admin)
 *   DELETE ?userId=…          → remove a member (owner cannot be removed)
 */
export const GET = withRoute<{ slug: string }>(async ({ user, params }) => {
  const app = await getAppBySlugForUser(params.slug, user);
  if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });
  const { members, canManage } = await listAppMembers(app.id, user);
  return NextResponse.json({ members, canManage });
}, { defaultStatus: 500 });

export const POST = withRoute<{ slug: string }, { userId?: string; role?: string }>(
  async ({ user, params, body }) => {
    const app = await getAppBySlugForUser(params.slug, user);
    if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });
    const userId = (body?.userId ?? '').trim();
    if (!userId) return NextResponse.json({ error: 'a userId is required' }, { status: 400 });
    const role: AppMemberRole = body?.role === 'admin' ? 'admin' : 'member';
    await addAppMember(app.id, user, userId, role); // 403 non-admin, 404 unknown user
    const { members, canManage } = await listAppMembers(app.id, user);
    return NextResponse.json({ members, canManage });
  },
  { parse: true, defaultStatus: 500 },
);

export const DELETE = withRoute<{ slug: string }>(async ({ user, params, req }) => {
  const app = await getAppBySlugForUser(params.slug, user);
  if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });
  const userId = (new URL(req.url).searchParams.get('userId') ?? '').trim();
  if (!userId) return NextResponse.json({ error: 'a userId is required' }, { status: 400 });
  await removeAppMember(app.id, user, userId); // 403 non-admin, 400 owner-removal
  const { members, canManage } = await listAppMembers(app.id, user);
  return NextResponse.json({ members, canManage });
}, { defaultStatus: 500 });
