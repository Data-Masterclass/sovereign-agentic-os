/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { TIER_MODELS } from '@/lib/agents/routing';

export const dynamic = 'force-dynamic';

/**
 * The per-agent model picker source — populated LIVE from the LiteLLM gateway's
 * /model/info (Bearer master key, server-side only; no endpoint or key reaches the
 * browser). When LiteLLM is unreachable (kind/offline) we degrade to the install
 * tier defaults and SAY SO, rather than hardcoding a model list in the UI.
 */
export async function GET() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${config.litellmUrl}/model/info`, {
      headers: { authorization: `Bearer ${config.litellmMasterKey}`, accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ model_name?: string }> };
      const models = Array.from(
        new Set((data?.data ?? []).map((m) => m.model_name).filter((n): n is string => typeof n === 'string' && n.length > 0)),
      );
      if (models.length > 0) return NextResponse.json({ models, source: 'litellm' });
    }
  } catch {
    /* fall through to the offline tier defaults */
  } finally {
    clearTimeout(timer);
  }
  // Offline: the install tier defaults (Ministral light / Qwen reasoning+vision).
  const models = Array.from(new Set(Object.values(TIER_MODELS)));
  return NextResponse.json({ models, source: 'offline' });
}
