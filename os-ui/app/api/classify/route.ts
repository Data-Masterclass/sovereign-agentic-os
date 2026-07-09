/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/core/config';

export const dynamic = 'force-dynamic';

/**
 * Classify + describe an unstructured document for the domain via the LiteLLM
 * gateway. The browser POSTs { title, text }; we ask the governed model for a
 * one-line description, a content type, and suggested tags, returning them for
 * review before the doc is curated into Knowledge. Key stays server-side.
 *
 * Offline (sovereign-mock) the model echoes context, so the structured fields
 * fall back to heuristics — labelled honestly in the response.
 */

const SYSTEM = [
  'You classify and describe a business document for a data catalog. Respond',
  'ONLY with compact JSON: {"description": string (<=160 chars), "contentType":',
  'one of ["policy","report","contract","email","spec","notes","manual","other"],',
  '"tags": string[] (<=5 lowercase tags)}. No prose outside the JSON.',
].join(' ');

function heuristic(title: string, text: string) {
  const t = `${title} ${text}`.toLowerCase();
  const pick = (): string => {
    if (/policy|gdpr|compliance|regulation/.test(t)) return 'policy';
    if (/report|quarter|revenue|kpi/.test(t)) return 'report';
    if (/contract|agreement|clause/.test(t)) return 'contract';
    if (/spec|requirement|design/.test(t)) return 'spec';
    if (/manual|guide|how to|procedure/.test(t)) return 'manual';
    return 'other';
  };
  const words = Array.from(new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 4))).slice(0, 5);
  return {
    description: (text.slice(0, 150) || title || 'Document').replace(/\s+/g, ' ').trim(),
    contentType: pick(),
    tags: words,
  };
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
  if (!text && !title) {
    return NextResponse.json({ error: 'Provide a document title or text' }, { status: 400 });
  }

  const payload = {
    model: config.litellmChatModel,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `TITLE: ${title}\n\nTEXT:\n${text.slice(0, 4000)}` },
    ],
    temperature: 0,
  };

  try {
    const res = await fetch(`${config.litellmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.litellmMasterKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    const raw = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `LiteLLM ${res.status}: ${raw.slice(0, 240)}` },
        { status: 502 },
      );
    }
    const data = JSON.parse(raw);
    const content = String(data?.choices?.[0]?.message?.content ?? '');
    // Try to parse the model's JSON; if it didn't return clean JSON (e.g. the
    // offline mock), fall back to a transparent heuristic classification.
    let parsed: { description?: string; contentType?: string; tags?: string[] } | null = null;
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
    if (parsed && (parsed.description || parsed.contentType)) {
      return NextResponse.json({
        source: 'llm',
        description: String(parsed.description ?? '').slice(0, 200),
        contentType: String(parsed.contentType ?? 'other'),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 5) : [],
      });
    }
    return NextResponse.json({ source: 'heuristic', ...heuristic(title, text) });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach LiteLLM: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
