import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

type Hit = {
  id: string;
  score: number;
  title: string;
  text: string;
};

/**
 * Knowledge / Search -> OpenSearch. The browser GETs ?q=...; we run a lexical
 * multi_match over the `knowledge` index server-side and return ranked hits.
 * The embedding vector is excluded from `_source` so we never ship it around.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') ?? '').trim();
  if (!q) {
    return NextResponse.json({ error: 'Missing query' }, { status: 400 });
  }

  const body = {
    size: 10,
    _source: { excludes: ['embedding'] },
    query: {
      multi_match: {
        query: q,
        fields: ['title^2', 'text'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    },
  };

  const url = `${config.opensearchUrl}/${config.knowledgeIndex}/_search`;
  try {
    const res = await fetch(url, {
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
    const hits: Hit[] = rawHits.map((h: Record<string, unknown>) => {
      const src = (h._source ?? {}) as Record<string, unknown>;
      return {
        id: String(h._id ?? ''),
        score: typeof h._score === 'number' ? h._score : 0,
        title: String(src.title ?? '(untitled)'),
        text: String(src.text ?? src.content ?? ''),
      };
    });
    const total =
      typeof data?.hits?.total?.value === 'number'
        ? data.hits.total.value
        : hits.length;
    return NextResponse.json({ query: q, total, index: config.knowledgeIndex, hits });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach OpenSearch: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
