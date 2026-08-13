/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { saveAppDraft } from '@/lib/software/apps';

export const dynamic = 'force-dynamic';

/**
 * PUT /api/apps/[id]/spec/draft — AUTOSAVE the composer's candidate `draftSpec` (os-ui 0.6.135,
 * the DRAFT/LIVE model). It calls `saveAppDraft` AS the signed-in user (SAME owner-or-in-domain-
 * builder authz as the spec route), persisting the work-in-progress WITHOUT the serve-validation
 * gate — a partial / not-yet-valid draft saves fine. NO version snapshot (Publish is the only
 * go-live gate). Debounce-friendly + idempotent: re-saving the same payload is a plain write.
 *
 * The app record always persists on save, so a work-in-progress app never disappears from the
 * tiles (the root-cause fix for "start a software, don't save → app gone").
 */
export const PUT = withRoute<{ id: string }, { draft?: unknown }>(async ({ user, params, body }) => {
  const app = await saveAppDraft(params.id, body?.draft, user);
  return NextResponse.json({ ok: true, id: app.id, updatedAt: app.updatedAt });
}, { parse: true, defaultStatus: 500 });
