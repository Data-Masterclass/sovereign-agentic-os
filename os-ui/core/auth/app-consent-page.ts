/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       auth
 * FEATURE:    App Builder (E) - the OS-rendered consent screen and error page of app sign-in
 * USER STORY: As a user I want to read, in my language, exactly what an app may do as me (which datasets, metrics,
 *             knowledge and files it reads, which agents it runs, which actions it takes) before I say yes.
 * ARCHITECTURE:
 *   - A self-contained HTML page (like the MCP consent page, app/(entry)/oauth/authorize): it is served by
 *     `/api/auth/app-consent/screen` with CONSENT_PAGE_HEADERS (no framing, no caching), so no page of another origin
 *     can embed it and click "Allow" for the user.
 *   - Pure: the caller passes the translator of the `settings` namespace (next-intl `getTranslations`), so the text
 *     lives in `os-ui/messages/<locale>/settings.json` (`appConsent.*`) and this module is unit-tested.
 *   - Everything that came from data (app name, item names, action descriptions, user name) is HTML-escaped.
 *   - The form posts back to the same origin with only the opaque request id and the decision; the request itself
 *     (app, redirect URI, state, PKCE challenge) never leaves the server.
 */
import type { AppTokenApp, AppTokenEnv } from '@core/auth/app-token';

export type ConsentT = (key: string, values?: Record<string, string | number>) => string;

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell(t: ConsentT, lang: string, inner: string): string {
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t('appConsent.pageTitle'))}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f4f1ea;color:#1a1813;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}
  .card{background:#fff;border:1px solid #e6e1d6;border-radius:16px;max-width:480px;width:100%;padding:28px 28px 24px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.06)}
  h1{font-size:19px;margin:0 0 6px;letter-spacing:-.01em}
  h2{font-size:13px;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:#6b6559}
  .muted{color:#6b6559;font-size:13.5px;margin:0 0 14px}
  .who{background:#faf8f3;border:1px solid #ece7dc;border-radius:12px;padding:12px 14px;margin:0 0 8px;font-size:13.5px}
  ul{margin:0;padding:0 0 0 18px;font-size:13.5px;color:#3a352c}
  li{padding:2px 0}
  .row{display:flex;gap:10px;margin-top:20px}
  button{flex:1;font:inherit;font-weight:600;border-radius:10px;padding:11px 14px;cursor:pointer;border:1px solid transparent}
  .approve{background:#1a1813;color:#fff}
  .deny{background:#fff;color:#1a1813;border-color:#d9d3c7}
  .fine{font-size:11.5px;color:#8a8474;margin:16px 0 0}
</style></head><body><main class="card">${inner}</main></body></html>`;
}

const KINDS = ['data', 'metrics', 'knowledge', 'files'] as const;

/** The consent screen for one pending app login. */
export function renderConsentPage(o: {
  t: ConsentT;
  lang: string;
  app: AppTokenApp;
  env: AppTokenEnv;
  user: { id: string; name: string };
  requestId: string;
  action: string;
}): string {
  const { t, app } = o;
  const envLabel = t(o.env === 'prod' ? 'appConsent.envProd' : 'appConsent.envDev');
  const sections: string[] = [];
  for (const kind of KINDS) {
    const items = app.reads.filter((r) => r.kind === kind);
    if (items.length === 0) continue;
    sections.push(`<h2>${esc(t(`appConsent.read.${kind}`))}</h2><ul>${items.map((i) => `<li>${esc(i.name || i.id)}</li>`).join('')}</ul>`);
  }
  if (sections.length === 0) sections.push(`<h2>${esc(t('appConsent.read.title'))}</h2><ul><li>${esc(t('appConsent.read.identityOnly'))}</li></ul>`);
  if (app.agents.length > 0) {
    sections.push(`<h2>${esc(t('appConsent.agents'))}</h2><ul>${app.agents.map((a) => `<li>${esc(a.name || a.id)}</li>`).join('')}</ul>`);
  }
  if (app.writeActions.length > 0) {
    sections.push(
      `<h2>${esc(t('appConsent.actions'))}</h2><ul>${app.writeActions
        .map((a) => `<li><strong>${esc(a.name)}</strong>${a.description ? ` – ${esc(a.description)}` : ''}</li>`)
        .join('')}</ul>`,
    );
  }
  return shell(
    t,
    o.lang,
    `<h1>${esc(t('appConsent.title', { app: app.name || app.slug }))}</h1>
    <p class="muted">${esc(t('appConsent.subtitle', { domain: app.domain, env: envLabel }))}</p>
    <div class="who">${esc(t('appConsent.signedInAs', { name: o.user.name, id: o.user.id }))}</div>
    ${sections.join('\n')}
    <p class="fine">${esc(t('appConsent.never'))}</p>
    <form method="post" action="${esc(o.action)}">
      <input type="hidden" name="request" value="${esc(o.requestId)}">
      <div class="row">
        <button class="deny" type="submit" name="decision" value="deny">${esc(t('appConsent.deny'))}</button>
        <button class="approve" type="submit" name="decision" value="approve">${esc(t('appConsent.approve'))}</button>
      </div>
    </form>
    <p class="fine">${esc(t('appConsent.revokeHint'))}</p>`,
  );
}

/** The error page of app sign-in (no redirect: the request could not be trusted). `error` is a typed code. */
export function renderAppLoginError(t: ConsentT, lang: string, error: string): string {
  const known = new Set(['invalid_app', 'invalid_env', 'invalid_state', 'invalid_nonce', 'pkce_s256_required', 'invalid_code_challenge', 'invalid_redirect_uri', 'app_not_found', 'unregistered_redirect_uri', 'consent_unavailable', 'consent_request_expired', 'consent_not_allowed', 'app_token_unavailable', 'rate_limited']);
  const key = error.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const reason = known.has(error) ? t(`appConsent.errors.${key}`) : t('appConsent.errors.generic');
  return shell(t, lang, `<h1>${esc(t('appConsent.errorTitle'))}</h1><p class="muted">${esc(reason)}</p><p class="fine">${esc(error)}</p>`);
}
