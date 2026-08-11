/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getBet } from '@/lib/bigbets/store';
import { principal } from '@/lib/bigbets/server';
import { sourceFor } from '@/lib/bigbets';
// Side-effect import: registers the REAL cross-tab reader so the picker surfaces
// the actual datasets/agents/dashboards/knowledge/files/metrics a student built.
import '@/lib/bigbets/real-sources';
import { type Tab } from '@/lib/bigbets';
import { listAppsForUser } from '@/lib/software';

export const dynamic = 'force-dynamic';

const TABS: Tab[] = ['data', 'metric', 'dashboard', 'software', 'agent', 'ml', 'knowledge', 'files', 'connection'];

/**
 * GET → list artifacts the caller can see for a given tab, so the component
 * picker can browse and choose rather than paste a raw id.
 *
 * canView-scoped: admin sees all; others see non-personal artifacts OR artifacts
 * whose domain is in their own domains (the same visibility gate that governs
 * the rest of the BigBets surface — never trust the client id; attachment is
 * still re-resolved server-side by the POST /components route).
 */
export const GET = withRoute<{ id: string }>(async ({ user, params, req }) => {
    const { id } = params;
    const p = principal(user);

    // Scope gate: confirm the caller can view this bet.
    getBet(id, p);

    const url = new URL(req.url);
    const tab = url.searchParams.get('tab') as Tab | null;
    if (!tab || !TABS.includes(tab)) {
      return NextResponse.json({ error: `tab must be one of: ${TABS.join(', ')}` }, { status: 400 });
    }

    // Software is the one tab whose governed list gate (`listAppsForUser`) is ASYNC,
    // so the synchronous `sourceFor(tab).list` reader seam can't wire it (see
    // real-sources.ts). This route IS async, so list it directly here — same
    // domain-scoped canView gate every other kind uses. Map the app tier → the
    // reference-card visibility/lifecycle exactly like `resolveLinkedComponent`.
    if (tab === 'software') {
      const apps = await listAppsForUser(user);
      return NextResponse.json({
        artifacts: apps.map((a) => ({
          id: a.id,
          title: a.name,
          tab: 'software' as Tab,
          lifecycle: a.visibility === 'Personal' ? 'draft' : 'deployed',
          visibility: a.visibility === 'Personal' ? 'personal' : a.visibility === 'Shared' ? 'shared' : 'marketplace',
        })),
      });
    }

    // canView-scoped at the source: REAL artifacts come through each tab's own
    // governed list(viewer) gate; in-memory drafts are filtered by the same
    // visibility rule (admin sees all; others see shared/certified/marketplace, or
    // personal artifacts in their own domain). Attachment is still re-resolved
    // server-side by POST /components — the picker never grants authority.
    const visible = sourceFor(tab).list({ viewer: p });

    return NextResponse.json({
      artifacts: visible.map((a) => ({
        id: a.id,
        title: a.title,
        tab: a.tab,
        lifecycle: a.lifecycle,
        visibility: a.visibility,
      })),
    });
}, { defaultStatus: 500 });
