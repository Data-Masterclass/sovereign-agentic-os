/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { currentUser, type CurrentUser } from '@/lib/core/auth';
import { validateAuthorizeRequest, issueCode, getClient, issuer, OAuthError, type AuthorizeRequest } from '@/lib/mcp/oauth';

export const dynamic = 'force-dynamic';

/**
 * OAuth 2.1 authorize endpoint. Reuses the OS cookie session: no session →
 * bounce to `/signin?next=<this authorize URL>` (same-origin path+query); signed
 * in → render an explicit one-click consent showing WHICH identity + role is
 * being delegated. On approve, mint a PKCE-bound single-use code and 302 back to
 * the client's registered redirect_uri. A creator's delegated token still cannot
 * exceed the creator role floor — role is re-resolved live on every call.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errorPage(e: unknown): NextResponse {
  const msg = e instanceof OAuthError ? `${e.code}: ${e.message}` : 'invalid authorization request';
  return new NextResponse(page(`<h1>Cannot connect</h1><p class="muted">${esc(msg)}</p>`), {
    status: e instanceof OAuthError ? e.status : 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function page(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect · Sovereign Agentic OS</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f4f1ea;color:#1a1813;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    min-height:100vh;display:grid;place-items:center;padding:24px}
  .card{background:#fff;border:1px solid #e6e1d6;border-radius:16px;max-width:440px;width:100%;
    padding:28px 28px 24px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.06)}
  h1{font-size:19px;margin:0 0 6px;letter-spacing:-.01em}
  .muted{color:#6b6559;font-size:13.5px;margin:0 0 18px}
  .who{display:flex;flex-direction:column;gap:2px;background:#faf8f3;border:1px solid #ece7dc;
    border-radius:12px;padding:14px 16px;margin:0 0 18px}
  .who .name{font-weight:600}
  .who .role{font-size:12.5px;color:#6b6559}
  .grants{margin:0 0 20px;padding:0;list-style:none;font-size:13.5px;color:#3a352c}
  .grants li{display:flex;gap:8px;padding:3px 0}
  .grants li::before{content:"✓";color:#3a7d44;font-weight:700}
  .row{display:flex;gap:10px}
  button{flex:1;font:inherit;font-weight:600;border-radius:10px;padding:11px 14px;cursor:pointer;border:1px solid transparent}
  .approve{background:#1a1813;color:#fff}
  .approve:hover{background:#000}
  .deny{background:#fff;color:#1a1813;border-color:#d9d3c7}
  .deny:hover{background:#f4f1ea}
  .fine{font-size:11.5px;color:#8a8474;margin:16px 0 0}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

async function consentPage(v: AuthorizeRequest, user: CurrentUser): Promise<string> {
  const client = await getClient(v.clientId);
  const clientName = esc(client?.clientName || 'Claude');
  const hidden = (['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'resource', 'scope', 'state'] as const)
    .map((k) => {
      const map: Record<string, string | undefined> = {
        response_type: 'code',
        client_id: v.clientId,
        redirect_uri: v.redirectUri,
        code_challenge: v.codeChallenge,
        code_challenge_method: 'S256',
        resource: v.resource,
        scope: v.scope,
        state: v.state,
      };
      const val = map[k];
      return val === undefined ? '' : `<input type="hidden" name="${k}" value="${esc(val)}">`;
    })
    .join('');
  return page(`
    <h1>Connect ${clientName} to your OS</h1>
    <p class="muted">${clientName} is requesting access to the Sovereign Agentic OS on your behalf.</p>
    <div class="who">
      <span class="name">${esc(user.name)}</span>
      <span class="role">Signed in as <strong>${esc(user.id)}</strong> · role <strong>${esc(user.role)}</strong></span>
    </div>
    <ul class="grants">
      <li>Run OS tools as <strong>you</strong>, scoped to your role</li>
      <li>Every call goes through the same governed path (OPA policy, audit, role gates)</li>
      <li>It cannot exceed your permissions — a creator stays a creator</li>
    </ul>
    <form method="post">
      ${hidden}
      <div class="row">
        <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
        <button class="approve" type="submit" name="decision" value="approve">Connect</button>
      </div>
    </form>
    <p class="fine">You can revoke access anytime by rotating your OS MCP secret. Access expires and refreshes automatically.</p>
  `);
}

function signinBounce(fallbackOrigin: string, next: string): NextResponse {
  // Behind the ingress, req.url's origin is the container's internal address
  // (0.0.0.0:3000) — a redirect there is unreachable from the user's browser and
  // breaks the whole managed-auth sign-in. Prefer the public base (OS_PUBLIC_URL,
  // the same value the discovery metadata advertises); fall back to the request
  // origin only for local dev where OS_PUBLIC_URL is unset.
  const base = issuer() || fallbackOrigin;
  const url = new URL(`/signin?next=${encodeURIComponent(next)}`, base);
  // 303: /signin is always a GET page — the bounce may be triggered from the consent
  // POST, and 307/302 would wrongly re-issue that as a POST.
  return NextResponse.redirect(url, 303);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  let v: AuthorizeRequest;
  try {
    v = await validateAuthorizeRequest(url.searchParams); // bad client/redirect must NOT redirect
  } catch (e) {
    return errorPage(e);
  }
  const user = await currentUser();
  if (!user) return signinBounce(url.origin, url.pathname + url.search);
  return new NextResponse(await consentPage(v, user), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params = new URLSearchParams();
  for (const [k, val] of form.entries()) params.set(k, String(val));

  let v: AuthorizeRequest;
  try {
    v = await validateAuthorizeRequest(params);
  } catch (e) {
    return errorPage(e);
  }

  const user = await currentUser();
  if (!user) {
    // Session expired between render and submit → re-authenticate, then return here.
    return signinBounce(req.nextUrl.origin, `/oauth/authorize?${params.toString()}`);
  }

  if (params.get('decision') !== 'approve') {
    const back = new URL(v.redirectUri);
    back.searchParams.set('error', 'access_denied');
    if (v.state) back.searchParams.set('state', v.state);
    // 303 See Other: the consent form is submitted via POST, and the OAuth redirect
  // to the client's callback MUST switch the browser to GET — a 307/302 here would
  // re-POST to claude.ai/api/mcp/auth_callback, which only accepts GET → the client
  // reports "Method Not Allowed" and the connection fails.
  return NextResponse.redirect(back, 303);
  }

  const code = issueCode({
    userId: user.id,
    clientId: v.clientId,
    redirectUri: v.redirectUri,
    codeChallenge: v.codeChallenge,
    resource: v.resource,
    scope: v.scope,
  });
  const back = new URL(v.redirectUri);
  back.searchParams.set('code', code);
  if (v.state) back.searchParams.set('state', v.state);
  // 303 See Other: the consent form is submitted via POST, and the OAuth redirect
  // to the client's callback MUST switch the browser to GET — a 307/302 here would
  // re-POST to claude.ai/api/mcp/auth_callback, which only accepts GET → the client
  // reports "Method Not Allowed" and the connection fails.
  return NextResponse.redirect(back, 303);
}
