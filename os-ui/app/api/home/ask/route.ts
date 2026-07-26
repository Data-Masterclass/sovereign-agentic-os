/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { ask } from '@/lib/home/assistant';

export const dynamic = 'force-dynamic';

/**
 * Ask the domain assistant. Two-mode + governed: it answers, or scaffolds a
 * Personal draft owned by the caller (RLS); promote/certify stay human. Every
 * turn is Langfuse-traced. Auth-gated so it always runs as the real viewer.
 */
export const POST = withRoute<Record<string, string>, { prompt?: unknown }>(async ({ user, body }) => {
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) {
    return NextResponse.json({ error: 'A prompt is required' }, { status: 400 });
  }
  const result = await ask(user, prompt);
  return NextResponse.json({ result });
}, { parse: true, defaultStatus: 500 });
