/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (C2) - an app's own logs in Dev, Prod or a preview slot, redacted
 * USER STORY: As an app builder I read what my app printed, without secrets, and never another app's output.
 * ARCHITECTURE: A SHELL over `lib/releases/logs.ts` (the same function as the MCP tool `get_app_logs`).
 *               `app_builder_disabled` first; the app's EDITORS only (`editableApp`: logs may hold user data; an app token
 *               is refused). env and slot are closed enums; the pods are selected by the app's own name, never by input.
 *               GET ?env=dev|prod&slot=p1|p2&tail=200. No log content is logged by os-ui.
 */
import { NextResponse } from 'next/server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { withRoute } from '@core/kernel/route-server';
import { editableApp, parseEnv } from '@tabs/software/lib/appdb/access';
import { isAppBuilderApp } from '@tabs/software/lib/review';
import { readAppLogs } from '@tabs/software/lib/releases/logs';

export const dynamic = 'force-dynamic';

const read = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const q = new URL(req.url).searchParams;
  const env = parseEnv(q.get('env'));
  const slotRaw = q.get('slot');
  const slot = slotRaw === null || slotRaw === '' ? undefined : slotRaw === 'p1' || slotRaw === 'p2' ? slotRaw : null;
  if (slot === null) return NextResponse.json({ error: 'slot must be "p1" or "p2"' }, { status: 400 });
  const app = await editableApp(params.id, user);
  if (!isAppBuilderApp(app)) return NextResponse.json({ error: 'only an App Builder app (nextjs-web@2) has app logs here' }, { status: 409 });
  return NextResponse.json(await readAppLogs(app, { env, slot, tail: Number(q.get('tail') ?? 200) }));
}, { defaultStatus: 500 });

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return appBuilderDisabledResponse() ?? read(req, ctx);
}
