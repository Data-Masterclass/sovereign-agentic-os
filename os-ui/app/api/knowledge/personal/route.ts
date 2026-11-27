/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { apiError, withRoute } from '@core/kernel/route-server';
import { listPersonalKnowledge, createPersonalKnowledge, ensureHydrated } from '@tabs/knowledge/lib/personal-store';
import { authorize, uploadCreateDecision, uploadCreateRefusalBody } from '@core/infra/governed';
import { auditUploadCreateRefused } from '@/upload-create-audit';

export const dynamic = 'force-dynamic';

/** GET → caller's personal knowledge grouped mine / domain / marketplace. Pass ?archived=1 to include archived. */
export const GET = withRoute(async ({ user, req }) => {
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get('archived') === '1';
    return NextResponse.json(listPersonalKnowledge(user, { includeArchived }));
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/** POST → create a personal knowledge entry (a titled markdown note about the user). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<Record<string, string>, any>(async ({ user, body }) => {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return apiError(400, 'A title is required.', 'knowledge.titleRequired');
    const domain = typeof body.domain === 'string' ? body.domain : undefined;
    // A personal note is always private (My scope): OPA decides the create first (`upload_create`, never fails open).
    const authz = await authorize(`user:${user.id}`, 'upload.create', uploadCreateDecision(user, 'knowledge', domain));
    if (!authz.allowed) {
      auditUploadCreateRefused(user, 'knowledge', 'POST /api/knowledge/personal', authz);
      return NextResponse.json(uploadCreateRefusalBody('knowledge'), { status: 403 });
    }
    const rec = createPersonalKnowledge(user, {
      title,
      md: typeof body.md === 'string' ? body.md : undefined,
      domain,
    });
    return NextResponse.json({ id: rec.id, title: rec.title });
}, { parse: true, hydrate: ensureHydrated, defaultStatus: 500 });
