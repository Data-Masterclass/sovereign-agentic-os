/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@core/kernel/route-server';
import { getAppForUser, updateAppDocs, patchAppDesign, renameApp, reconcileBuiltStatus, setAppServeMode, normalizeServeMode, type AppEpic } from '@tabs/software/lib/apps';
import { normalizeContextGrants } from '@core/kernel/context-grants';
import { normalizeAgentGrants } from '@tabs/software/lib/app-agent-grants';
import { reconcileDeployApproval } from '@tabs/software/lib/review';
import { getConnectionByApp } from '@core/infra/app-registry';

export const dynamic = 'force-dynamic';

/** One app's full home-of-record (design/data/docs/chat/MCP). */
export const GET = withRoute<{ id: string }>(async ({ user, params }) => {
  const { id } = params;
  const app = await getAppForUser(id, user);
  // SELF-HEAL: if this app is stuck in `review` but its deploy approval was
  // already decided (an orphan from before the approve→decideDeploy write-back),
  // reconcile it to its true state on load. Idempotent + fail-soft (never blocks
  // the load); mutates the same in-cache app object, so the response is healed.
  await reconcileDeployApproval(app);
  // SELF-HEAL 2: story built-ness must be EARNED — demote any `done`/`building` claim on
  // an app with no generated files (heals the "N stories built but no code / Test
  // disabled" phantom).
  reconcileBuiltStatus(app);
  const connection = getConnectionByApp(app.id);
  return NextResponse.json({ user, app, connection });
}, { defaultStatus: 500 });

/**
 * Edit the app's captured docs (design decisions / data descriptions / docs) AND its
 * Define/Design surfaces (purpose · epics · context grants). Both go through the same
 * owner-or-domain-admin edit-scope in the lib layer. A body carrying only design/data/
 * docs keeps the historic behaviour; purpose/epics/grants patch the new fields.
 */
export const PATCH = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const body = await req.json();

  // Phase D: the serve-mode toggle ('image' | 'runtime'). Edit-scoped in the lib, which
  // ALSO refuses 'runtime' for a non-Vite shape (400) — a dedicated field so the Publish
  // switch flips it without touching docs/design. normalizeServeMode guards the input.
  if (body?.serveMode !== undefined) {
    const app = await setAppServeMode(id, user, normalizeServeMode(body.serveMode));
    return NextResponse.json({ app });
  }

  // Define/Design fields, when present, persist through patchAppDesign.
  const hasDesign =
    body?.purpose !== undefined || body?.epics !== undefined ||
    body?.grants !== undefined || body?.agents !== undefined;
  if (hasDesign) {
    const app = await patchAppDesign(id, user, {
      purpose: body?.purpose !== undefined ? String(body.purpose) : undefined,
      epics: body?.epics !== undefined ? (body.epics as AppEpic[]) : undefined,
      grants: body?.grants !== undefined ? normalizeContextGrants(body.grants) : undefined,
      agents: body?.agents !== undefined ? normalizeAgentGrants(body.agents) : undefined,
    });
    return NextResponse.json({ app });
  }

  const app = await updateAppDocs(id, user, {
    designDecisions: body?.designDecisions !== undefined ? String(body.designDecisions) : undefined,
    dataDescriptions: body?.dataDescriptions !== undefined ? String(body.dataDescriptions) : undefined,
    docs: body?.docs !== undefined ? String(body.docs) : undefined,
  });
  return NextResponse.json({ app });
}, { defaultStatus: 500 });

/**
 * POST → app actions. Today exactly `rename` (change the DISPLAY name only). The
 * store freezes the physical `slug` (image/container identity), so no container
 * image or subdomain ever moves. Edit-scoped
 * (owner or in-domain admin) — a mere viewer is rejected 403. Mirrors the Data
 * tab's dataset rename route (parity rollout).
 */
export const POST = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const { id } = params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; name?: string };
  switch (body.action) {
    case 'rename': {
      const app = await renameApp(id, user, body.name ?? '');
      return NextResponse.json({ app });
    }
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}, { defaultStatus: 500 });
