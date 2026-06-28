/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Unstructured Data ingest + knowledge listing -> OpenSearch.
 *
 *  GET  -> list the current documents in the knowledge index (newest first),
 *          excluding the embedding vector from `_source`.
 *  POST -> ingest a pasted document ({ title, text }) into the same index so
 *          the agents' RAG can retrieve it. (Files run through Docling first;
 *          its parsed markdown lands here the same way.)
 *
 * All OpenSearch access stays server-side; the index URL never reaches the
 * browser.
 */

const base = () => `${config.opensearchUrl}/${config.knowledgeIndex}`;

type Doc = { id: string; title: string; excerpt: string; source: string; ingestedAt: string | null };

export async function GET() {
  const body = {
    size: 50,
    _source: { excludes: ['embedding'] },
    // `unmapped_type` so the sort tolerates the field being absent until the
    // first ingest creates it (the seeded knowledge docs have no ingested_at).
    sort: [{ ingested_at: { order: 'desc', missing: '_last', unmapped_type: 'date' } }],
    query: { match_all: {} },
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
