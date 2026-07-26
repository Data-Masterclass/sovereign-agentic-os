/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { listWorkflows } from '@/lib/knowledge/store';

export const dynamic = 'force-dynamic';

/**
 * GET ?q=&for=data|agents|software → workflows the user can ATTACH AS CONTEXT in
 * another tab (the "context out" handover). Other tabs call this to auto-suggest
 * relevant workflows while building a data product / agent / app; attaching one
 * means adding its `attachRef` (knowledge:workflow:<id>) to the consumer's
 * knowledge grants, after which the governed `retrieve` tool serves its units.
 *
 * Only workflows the caller may see are returned (the store's view scope); a light
 * keyword filter ranks by title/domain match.
 */
export const GET = withRoute(async ({ user, req }) => {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get('q') ?? '').trim().toLowerCase();

    const groups = listWorkflows(user);
    const all = [...groups.mine, ...groups.domain, ...groups.marketplace];

    const ranked = all
      .map((w) => {
        const hay = `${w.title} ${w.domain}`.toLowerCase();
        const score = q ? (hay.includes(q) ? 2 : q.split(/\s+/).some((t) => hay.includes(t)) ? 1 : 0) : 1;
        return { w, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.w.title.localeCompare(b.w.title))
      .slice(0, 8)
      .map(({ w }) => ({
        id: w.id,
        title: w.title,
        domain: w.domain,
        visibility: w.visibility,
        status: w.status,
        attachRef: `knowledge:workflow:${w.id}`,
      }));

    return NextResponse.json({ suggestions: ranked });
}, { defaultStatus: 500 });
