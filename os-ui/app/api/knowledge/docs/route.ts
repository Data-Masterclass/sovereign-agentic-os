/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/core/config';
import { requireUser } from '@/lib/core/auth';
import { errorResponse } from '@/lib/data/server';
import { dlsFilter } from '@/lib/knowledge/retrieve';

export const dynamic = 'force-dynamic';

/**
 * Unstructured Data ingest + knowledge listing -> OpenSearch.
 *
 *  GET  -> list the documents in the knowledge index the CALLER may see (DLS grant
 *          filter pushed down — the same filter `retrieveKnowledge` uses), newest
 *          first, excluding the embedding vector. A student never sees another
 *          domain's or student's docs.
 *  POST -> ingest a pasted document ({ title, text }) into the same index, STAMPED
 *          with the caller's owner/domain and Personal visibility so it is DLS-
 *          scoped from the start. (Files run through Docling first; its parsed
 *          markdown lands here the same way.)
 *
 * Both require a session (401 for anon). All OpenSearch access stays server-side;
 * the index URL never reaches the browser.
 */

const base = () => `${config.opensearchUrl}/${config.knowledgeIndex}`;

type Doc = { id: string; title: string; excerpt: string; source: string; ingestedAt: string | null };

export async function GET() {
  let principal;
  try {
    const u = await requireUser();
    principal = { id: u.id, domains: u.domains, role: u.role };
  } catch (e) {
    return errorResponse(e);
  }
  const body = {
    size: 50,
    _source: { excludes: ['embedding'] },
    // `unmapped_type` so the sort tolerates the field being absent until the
    // first ingest creates it (the seeded knowledge docs have no ingested_at).
    sort: [{ ingested_at: { order: 'desc', missing: '_last', unmapped_type: 'date' } }],
    // DLS grant filter: only units the caller may see (owner / same-domain Shared /
    // Marketplace / builder-admin same-domain Personal). Same filter as retrieval.
    query: { bool: { must: [{ match_all: {} }], filter: [dlsFilter(principal)] } },
  };
  try {
    const res = await fetch(`${base()}/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `OpenSearch ${res.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = JSON.parse(text);
    const rawHits = Array.isArray(data?.hits?.hits) ? data.hits.hits : [];
    const docs: Doc[] = rawHits.map((h: Record<string, unknown>) => {
      const src = (h._source ?? {}) as Record<string, unknown>;
      const t = String(src.text ?? src.content ?? '');
      return {
        id: String(h._id ?? ''),
        title: String(src.title ?? '(untitled)'),
        excerpt: t.length > 240 ? `${t.slice(0, 240)}…` : t,
        source: String(src.source ?? 'knowledge'),
        ingestedAt: src.ingested_at ? String(src.ingested_at) : null,
      };
    });
    const total =
      typeof data?.hits?.total?.value === 'number' ? data.hits.total.value : docs.length;
    return NextResponse.json({ index: config.knowledgeIndex, total, docs });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach OpenSearch: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}

export async function POST(req: Request) {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return errorResponse(e);
  }
  let title = '';
  let text = '';
  try {
    const body = await req.json();
    title = (body?.title ?? '').toString().trim();
    text = (body?.text ?? '').toString().trim();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: 'Document text is required' }, { status: 400 });
  }

  const doc = {
    title: title || `Pasted document · ${new Date().toISOString().slice(0, 10)}`,
    text,
    source: 'os-ui-ingest',
    ingested_at: new Date().toISOString(),
    // DLS labels from the SESSION (never the request body) so the doc is scoped to
    // the ingesting user's domain from the first read. Personal by default — a
    // Builder promotes it later; the campaign seed ingests as the instructor.
    owner: u.id,
    domain: u.domains[0] ?? '',
    visibility: 'Personal',
  };

  try {
    const res = await fetch(`${base()}/_doc?refresh=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(doc),
      cache: 'no-store',
    });
    const resText = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `OpenSearch ${res.status}: ${resText.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = JSON.parse(resText);
    return NextResponse.json({ id: String(data?._id ?? ''), title: doc.title, ingested: true });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach OpenSearch: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
