/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { requireUser } from '@/lib/core/auth';
import { ensureHydrated } from '@/lib/software/apps';
import { serveAppRuntime } from '@/lib/software/app-runtime';

export const dynamic = 'force-dynamic';

/**
 * PHASE D — the OS no-image runtime serving surface (flagged per app via serveMode).
 *
 *   GET /api/apps/runtime/{slug}
 *
 * Serves a `serveMode:'runtime'` app's committed tree DIRECTLY: it resolves the app by
 * its frozen slug under the SAME domain-wide visibility gate deployed apps use, runs
 * the Phase-A compile gate over the tree, and serves the bundled SPA inside a
 * sandboxed, SAME-ORIGIN iframe with a strict CSP. No per-app image/CI/registry/pod is
 * involved — the OS itself is the runtime.
 *
 * Auth: any signed-in user who can SEE the app (requireUser + the visibility gate in
 * serveAppRuntime). The app calls back into the OS same-origin as this same session
 * (the reused ambient soa_session bridge), so governance still decides what data
 * renders — this surface ships the app's own code + a real error, never granted data.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    const user = await requireUser();
    await ensureHydrated();
    const { slug } = await ctx.params;
    const { html, status, csp } = await serveAppRuntime(slug, user);
    return new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': csp,
        // The bundle is user-scoped + may change on the next commit — never shared-cache.
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        // Defence-in-depth alongside the CSP frame-ancestors 'self'.
        'x-frame-options': 'SAMEORIGIN',
      },
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    // Honest text — never a broken/blank HTML shell.
    return new Response(
      status === 401 ? 'Sign in to the OS to open this app.' : `Runtime serving error: ${(e as Error).message}`,
      { status, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }
}
