/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getAppBySlugForUser } from '@/lib/software/apps';
import { availableContext } from '@/lib/software/available-context';
import { CONTEXT_KINDS, type ContextKind } from '@/lib/core/context-grants';

export const dynamic = 'force-dynamic';

/**
 * The deployed app's ACTUAL granted context — the honest "Granted context" surface.
 * Keyed by the frozen `slug` the app baked in (`APP_SLUG`), same auth + visibility
 * gate as the members route. This exists because the generic `/api/context/available`
 * feed returns everything the SIGNED-IN USER can see (all domain artifacts), NOT what
 * the APP was granted — labelling that "Granted context" was a lie.
 *
 * Returns ONLY the app's grants (`app.grants`), resolved to display names from the
 * SAME canView/RLS-scoped stores the grant picker uses (`availableContext`). An
 * artifact that no longer exists (or the caller can't resolve) is kept with
 * `name: id` — honest, never silently dropped.
 *
 *   GET → { items: [{ kind, id, name, access }] }
 */
export const GET = withRoute<{ slug: string }>(async ({ user, params }) => {
  const app = await getAppBySlugForUser(params.slug, user);
  if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });

  // One canView/RLS-scoped name lookup per kind the app actually has grants in.
  const kindsWithGrants = CONTEXT_KINDS.filter((k) => app.grants[k].length > 0);
  const names = await availableContext(user, kindsWithGrants);
  const nameFor = (kind: ContextKind, id: string): string =>
    names[kind]?.find((i) => i.id === id)?.name ?? id; // honest fallback: the id itself

  const items = CONTEXT_KINDS.flatMap((kind) =>
    app.grants[kind].map((g) => ({ kind, id: g.id, name: nameFor(kind, g.id), access: g.access })),
  );
  return NextResponse.json({ items });
}, { defaultStatus: 500 });
