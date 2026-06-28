import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Chat -> sample-agent. The browser POSTs { question }; we call the in-cluster
 * sample-agent's GET /ask?q= server-side and return its grounded answer +
 * retrieved source titles. No backend address ever reaches the browser.
 */
export async function POST(req: Request) {
  let question = '';
  try {
    const body = await req.json();
    question = (body?.question ?? '').toString().trim();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!question) {
    return NextResponse.json({ error: 'Missing question' }, { status: 400 });
  }

  const url = `${config.sampleAgentUrl}/ask?q=${encodeURIComponent(question)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `sample-agent ${res.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const data = JSON.parse(text);
    return NextResponse.json({
      question: data.question ?? question,
      answer: data.answer ?? '',
      retrieved: Array.isArray(data.retrieved) ? data.retrieved : [],
      traced: Boolean(data.traced_in_langfuse),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach sample-agent: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
