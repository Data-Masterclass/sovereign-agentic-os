/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getEditableAppForUser } from '@/lib/software/apps';
import { commitToApp } from '@/lib/software/server';
import { validateFrontendImport } from '@/lib/software/design-push';

export const dynamic = 'force-dynamic';

/** Fetch a URL's text (bounded), honest on failure. Only http(s) URLs. */
async function fetchDesignFromUrl(url: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only http(s) URLs can be imported.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(parsed.toString(), { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: `Could not fetch the design (HTTP ${res.status}).` };
    return { ok: true, text: await res.text() };
  } catch {
    return { ok: false, reason: 'Could not reach that URL.' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seed a Claude-generated frontend (pasted CODE or a URL) into the app's frontend as
 * the starting point the AI build then refines. Writes through the SAME governed
 * `commitToApp` path every build/commit uses (into `src/`), so the metadata parse +
 * auto-MCP recompile + snapshot all run. Edit-gated (owner / domain_admin+). HONEST:
 * non-frontend or unreachable input is rejected with a reason — nothing fabricated.
 *
 * Body: { code?: string, url?: string }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const app = await getEditableAppForUser(id, user);
    const body = (await req.json().catch(() => ({}))) as { code?: string; url?: string };

    let raw = String(body.code ?? '').trim();
    if (!raw && body.url) {
      const fetched = await fetchDesignFromUrl(String(body.url).trim());
      if (!fetched.ok) return NextResponse.json({ error: fetched.reason }, { status: 400 });
      raw = fetched.text;
    }

    const validated = validateFrontendImport(raw);
    if (!validated.ok) return NextResponse.json({ error: validated.reason }, { status: 400 });

    const { app: updated, step } = await commitToApp(
      id,
      { id: user.id },
      validated.files,
      `Seed frontend from Claude design (${app.name})`,
    );
    return NextResponse.json({
      seeded: validated.files.map((f) => f.path),
      mode: step.mode,
      app: { id: updated.id, updatedAt: updated.updatedAt },
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
