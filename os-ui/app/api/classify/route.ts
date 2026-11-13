/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * FEATURE:    Classify + describe an unstructured document through the governed gateway.
 * USER STORY: As a curator I paste a document and get a description, a content type and tags to
 *             review before it enters Knowledge — metered against my domain, never against an
 *             unlimited credential.
 * ARCHITECTURE:
 *   - Session-gated. A3: the call carries the SCOPED credential (`callerCredential`, tab
 *     `classify`, the caller's domain) — the master key never touches an inference path; a budget
 *     rejection is a typed 402, an allowlist refusal a typed 403, never a raw 400 proxied through.
 *   - Deterministic (temperature 0) and asked to be CACHED by the gateway (`cache.use-cache`): the
 *     chart runs LiteLLM's Valkey cache in `default_off` mode, so only paths that opt in are cached.
 *   - Offline (sovereign-mock) the model echoes context, so the structured fields fall back to
 *     heuristics — labelled honestly in the response (`source: 'heuristic'`).
 */
import { NextResponse } from 'next/server';
import { config } from '@core/kernel/config';
import { withRoute } from '@core/kernel/route-server';
import {
  callerCredential,
  classifyRejection,
  isClientRejection,
  runCredentialConfigured,
} from '@core/infra/litellm-credential';

export const dynamic = 'force-dynamic';

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

/** The HTTP status a typed gateway rejection maps to (budget → 402, allowlist → 403, key → 503). */
function rejectionStatus(code: ReturnType<typeof classifyRejection>): number {
  if (code === 'budget_exceeded') return 402;
  if (code === 'forbidden') return 403;
  if (code === 'unauthorized') return 503;
  if (code === 'rate_limited') return 429;
  return 502;
}

// Requires a session: this proxies to the LLM gateway with the server-side SCOPED
// key — never expose it to anonymous callers (unmetered model abuse).
export const POST = withRoute<Record<string, string>, { title?: unknown; text?: unknown }>(async ({ user, body }) => {
  const title = (body?.title ?? '').toString().trim();
  const text = (body?.text ?? '').toString().trim();
  if (!text && !title) {
    return NextResponse.json({ error: 'Provide a document title or text' }, { status: 400 });
  }
  if (!runCredentialConfigured()) {
    return NextResponse.json({ error: 'No scoped LiteLLM key is configured (LITELLM_AGENT_KEY) — classification is unavailable' }, { status: 503 });
  }
  const cred = callerCredential({
    userId: user.id,
    domain: user.activeDomain ?? user.domains[0] ?? 'none',
    tab: 'classify',
  });

  const payload = {
    model: config.litellmChatModel,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `TITLE: ${title}\n\nTEXT:\n${text.slice(0, 4000)}` },
    ],
    temperature: 0,
    user: cred.user,
    metadata: { tags: cred.tags },
    // Deterministic path: opt into the gateway cache (chart: cache_params.mode default_off).
    cache: { 'use-cache': true },
  };

  try {
    const res = await fetch(`${config.litellmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cred.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    const raw = await res.text();
    if (!res.ok) {
      if (isClientRejection(res.status)) {
        const code = classifyRejection(res.status, raw);
        return NextResponse.json({ error: `LiteLLM refused the call (${code})`, code }, { status: rejectionStatus(code) });
      }
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
}, { parse: true, invalidJsonStatus: 400, defaultStatus: 401 });
