/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { goLive, retire, previewGoLive, previewRetire, lifecycleStatus } from '@core/kernel/go-live';

export const dynamic = 'force-dynamic';

/**
 * The UI twin of the two MCP verbs. Both doors call the SAME functions in
 * `@core/kernel/go-live`, so the guard, the refusal text and the pin cannot drift between a
 * click and a tool call. The acting principal always comes from the session.
 *
 * GET  /api/lifecycle?kind=&id=[&action=preview|retire-preview]  → status, or the confirm copy
 * POST /api/lifecycle  { action: 'go_live' | 'retire', kind, id, sha? }
 *
 * Review M-2: this route passes no `hydrate:` because it is POLYMORPHIC — it serves seven kinds
 * and cannot know which store to warm. Each adapter's own `resolve` awaits its tab's
 * `ensureHydrated()` instead, which is both correct on a cold pod and the only place that knows
 * what "hydrated" means for that kind.
 */
export const GET = withRoute(async ({ user, req }) => {
  const q = new URL(req.url).searchParams;
  const kind = (q.get('kind') ?? '').trim();
  const id = (q.get('id') ?? '').trim();
  const action = q.get('action') ?? '';
  if (!kind || !id) return NextResponse.json({ error: 'kind and id are required' }, { status: 400 });
  if (action === 'preview') return NextResponse.json(await previewGoLive(user, kind, id, q.get('sha') ?? undefined));
  if (action === 'retire-preview') return NextResponse.json(await previewRetire(user, kind, id));
  return NextResponse.json(await lifecycleStatus(user, kind, id));
}, { defaultStatus: 500 });

export const POST = withRoute<Record<string, string>, Record<string, unknown>>(async ({ user, body, req }) => {
  const kind = String(body?.kind ?? '').trim();
  const id = String(body?.id ?? '').trim();
  const action = String(body?.action ?? '').trim();
  if (!kind || !id) return NextResponse.json({ error: 'kind and id are required' }, { status: 400 });
  const surface = `ui:${new URL(req.url).pathname}`;
  if (action === 'go_live') {
    const sha = String(body?.sha ?? '').trim() || undefined;
    return NextResponse.json(await goLive(user, kind, id, sha, { surface }));
  }
  if (action === 'retire') return NextResponse.json(await retire(user, kind, id, { surface }));
  return NextResponse.json({ error: "action must be 'go_live' or 'retire'" }, { status: 400 });
}, { parse: true, defaultStatus: 500 });
