/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - the Stories view's door: read the living spec, save a story or an epic, migrate the record
 * USER STORY: As a business user I want to see my app's epics and stories and edit one in place, each save becoming a
 *             commit with my name, and a save that would break the spec refused with the reason.
 * ARCHITECTURE:
 *   - Thin shell over tabs/software/lib/stories/store.ts (the same functions the MCP tools call). The App Builder guard
 *     runs FIRST (flag off ⇒ 403 `app_builder_disabled`, before the session gate or any read).
 *   - GET `?sha=` → `storiesView` (visible app). PUT `{ op: 'saveStory', story }` | `{ op: 'saveEpic', epic }` |
 *     `{ op: 'migrate' }`: OPA `authorize()` (`software_checks`, creator and up) before the effect, then the store's
 *     edit scope. Bodies over 64 KB are refused (413). A spec violation is 422 with `issues`.
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { authorize } from '@core/infra/governed';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { saveEpic, saveStory, storiesView, SpecValidationError, type EpicInput, type StoryInput } from '@tabs/software/lib/stories/store';
import { migrateEpicsToFiles } from '@tabs/software/lib/stories/migrate';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

type Ctx = { params: Promise<{ id: string }> };

const get = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const sha = new URL(req.url).searchParams.get('sha') ?? undefined;
  return NextResponse.json(await storiesView(params.id, user, sha));
}, { defaultStatus: 500 });

const put = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return NextResponse.json({ error: `the request is larger than ${MAX_BODY_BYTES} bytes` }, { status: 413 });
  let body: { op?: unknown; story?: unknown; epic?: unknown };
  try {
    body = JSON.parse(raw || '{}') as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !['saveStory', 'saveEpic', 'migrate'].includes(String(body.op))) {
    return NextResponse.json({ error: "op must be 'saveStory', 'saveEpic' or 'migrate'" }, { status: 400 });
  }
  const decision = await authorize(`user:${user.id}`, 'software_checks');
  if (!decision.allowed) return NextResponse.json({ error: `OPA refused changing the stories (${decision.policy})` }, { status: 403 });
  try {
    if (body.op === 'migrate') return NextResponse.json(await migrateEpicsToFiles(params.id, user));
    if (body.op === 'saveStory') {
      const r = await saveStory(params.id, user, body.story as StoryInput, { source: 'ui' });
      return NextResponse.json({ sha: r.sha, changed: r.changed, story: r.story });
    }
    const r = await saveEpic(params.id, user, body.epic as EpicInput, { source: 'ui' });
    return NextResponse.json({ sha: r.sha, changed: r.changed, epic: r.epic });
  } catch (e) {
    if (e instanceof SpecValidationError) return NextResponse.json({ error: e.message, code: e.code, issues: e.issues }, { status: 422 });
    throw e;
  }
}, { defaultStatus: 500 });

export async function GET(req: Request, ctx: Ctx) {
  return appBuilderDisabledResponse() ?? get(req, ctx);
}

export async function PUT(req: Request, ctx: Ctx) {
  return appBuilderDisabledResponse() ?? put(req, ctx);
}
