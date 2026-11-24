/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Tool consoles — the request-time pieces the proxy route and the short addresses share
 * USER STORY: As a platform admin I type <domain>/dagster and land in the console when it is on;
 *             as a signed-out visitor I am sent to sign in; as anyone else, or while it is off, I
 *             get a plain 404.
 * ARCHITECTURE:
 *   - Reads the session (`requireUser`) and the switch (settings, hydrated first), then asks the
 *     kernel's pure decisions (`shortAddressFor`, `gateToolRequest`). Route files stay thin.
 *   - Redirects carry a RELATIVE Location (RFC 9110 allows it), so the public host behind the
 *     ingress never has to be reconstructed from the request.
 */
import { requireUser, type CurrentUser } from '@core/kernel/auth';
import { shortAddressFor } from '@core/infra/tool-proxy';
import { ensureHydrated, toolConsoleExposed } from '@tabs/admin/lib/settings';

/** A top-level page load (or a framed document), as opposed to a script, XHR or asset fetch. */
export function isNavigation(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const mode = req.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (req.headers.get('accept') ?? '').includes('text/html');
}

/** 307 to the sign-in page, coming back to exactly this path afterwards. */
export function signInRedirect(req: Request): Response {
  const u = new URL(req.url);
  const next = encodeURIComponent(u.pathname + u.search);
  return new Response(null, { status: 307, headers: { location: `/signin?next=${next}`, 'cache-control': 'no-store' } });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** The session, or the response a signed-out caller gets (sign-in for a page, else 401/403). */
export async function userOrResponse(
  req: Request,
  opts: { page?: boolean } = {},
): Promise<{ user: CurrentUser } | { response: Response }> {
  try {
    return { user: await requireUser() };
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 401;
    if (status === 401 && (opts.page || isNavigation(req))) return { response: signInRedirect(req) };
    return {
      response: new Response(JSON.stringify({ error: (e as Error).message }), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }),
    };
  }
}

/** Is this tool's console switched on? Hydrates the settings first (a fresh pod reads the store). */
export async function consoleExposed(key: string): Promise<boolean> {
  await ensureHydrated();
  return toolConsoleExposed(key);
}

/**
 * `GET /<key>` (a short address): 308 to `/tools/<key>/` for an admin while the console is on and
 * servable; 404 for everyone and everything else; sign-in for a signed-out visitor.
 */
export async function shortAddressResponse(req: Request, key: string): Promise<Response> {
  // A short address is always a page someone typed: signed out, it goes to sign-in.
  const who = await userOrResponse(req, { page: true });
  if ('response' in who) return who.response;
  const target = shortAddressFor(key, { exposed: await consoleExposed(key), role: who.user.role });
  if (!target) return notFound();
  return new Response(null, { status: 308, headers: { location: target, 'cache-control': 'no-store' } });
}
