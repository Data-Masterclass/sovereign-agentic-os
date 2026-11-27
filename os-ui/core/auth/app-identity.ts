/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       auth
 * FEATURE:    App Builder (E) - the production wiring of app sign-in: real port, consent store, OPA, audit, keys
 * USER STORY: As the OS owner I want every app sign-in, consent, revoke and token to go through the same OPA, the
 *             same audit trail and the same live user record as the rest of the OS.
 * ARCHITECTURE:
 *   - Binds the injected collaborators of `app-login.ts` / `app-token.ts` to the real ones: the registered
 *     `AppTokenPort` (Software tab, via instrumentation), `app-consent.ts`, the hash-chained audit
 *     (`core/policy/audit.ts`, action `access.grant` with `detail.event` naming the app event) and the live
 *     principal (`principalById`, the same re-read the MCP bearer and parked runs use).
 *   - The OPA calls (`authorize()` with `app_consent_write` / `app_token_issue`, core/infra/governed.ts) stay IN the
 *     mutating routes that own them (GLUE-7), and are passed in as the `authorize` collaborator.
 *   - Routes and `core/kernel/auth.ts` import only this module, so there is one production path.
 */
import 'server-only';
import { record as recordAudit } from '@core/policy/audit';
import { AppTokenRejected, AppTokenUnavailable, appTokenPort, authenticateAppBearer, mintAppToken, type AcceptedAppBearer, type AppPrincipal } from '@core/auth/app-token';
import { consentFor, grantConsent } from '@core/auth/app-consent';
import type { AuditFn, ExchangeDeps, LoginDeps } from '@core/auth/app-login';
import { renderAppLoginError, type ConsentT } from '@core/auth/app-consent-page';
import { CONSENT_PAGE_HEADERS } from '@core/auth/consent-headers';
import { config } from '@core/kernel/config';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@core/i18n/config';

/** Audit one app sign-in event. Never carries a token, a code or a verifier. */
export const auditAppEvent: AuditFn = (e) => {
  try {
    recordAudit({
      actor: e.actor,
      action: 'access.grant',
      subject: e.app ? `app:${e.app.domain}/${e.app.slug}${e.env ? `:${e.env}` : ''}` : 'app:unknown',
      domain: e.app?.domain ?? '',
      reason: e.event,
      detail: { event: e.event, outcome: e.outcome, ...(e.app ? { appId: e.app.id } : {}), ...(e.detail ?? {}) },
      ...(e.decisionId ? { decisionId: e.decisionId } : {}),
      ...(e.policyRev ? { policyRev: e.policyRev } : {}),
    });
  } catch (err) {
    // The audit store is down: say so in the log (no token material), never fail the sign-in silently either way.
    console.error(`[app-identity] audit write failed for ${e.event}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/** The live principal of a user id (lazy import: auth.ts imports this module). */
async function livePrincipal(id: string): Promise<AppPrincipal | null> {
  const { principalById } = await import('@core/kernel/auth');
  return principalById(id);
}

export function loginDeps(): LoginDeps {
  return { port: appTokenPort(), consentFor, audit: auditAppEvent };
}

/** The exchange's collaborators; the OPA decision (`authorize`) is passed by the route, which owns that call. */
export function exchangeDeps(authorize: ExchangeDeps['authorize']): ExchangeDeps {
  return {
    ...loginDeps(),
    principal: livePrincipal,
    authorize,
    mint: (user, app, env, scope, nonce) => mintAppToken(user, { app, env, scope, ...(nonce ? { nonce } : {}) }),
  };
}

export function consentDeps() {
  return { ...loginDeps(), grant: grantConsent };
}

/**
 * Accept an app bearer for one request (the kernel's door; see core/kernel/auth.ts). A refusal of the token (or no
 * key) is a typed `{ ok: false, reason }`, which the door answers as "not signed in"; anything else is rethrown.
 */
export async function acceptAppBearer(token: string, method: string, pathname: string): Promise<{ ok: true; accepted: AcceptedAppBearer } | { ok: false; reason: string }> {
  try {
    const accepted = await authenticateAppBearer(token, method, pathname, {
      principal: livePrincipal,
      consent: async (userId, app, env) => consentFor(userId, app, env),
    });
    return { ok: true, accepted };
  } catch (e) {
    if (e instanceof AppTokenRejected || e instanceof AppTokenUnavailable) return { ok: false, reason: e.message };
    throw e;
  }
}

// ------------------------------------------------------------------ HTTP glue --

/** The user's UI language (English when unknown or signed out). */
export async function appIdentityLocale(userId?: string | null): Promise<Locale> {
  if (!userId) return DEFAULT_LOCALE;
  const { getUserLocale } = await import('@core/i18n/server');
  const l = await getUserLocale(userId);
  return isLocale(l) ? l : DEFAULT_LOCALE;
}

/** The `settings` namespace translator for an explicit locale (works in route handlers). */
export async function settingsT(locale: Locale): Promise<ConsentT> {
  const { getTranslations } = await import('@core/i18n/server');
  const t = await getTranslations({ locale, namespace: 'settings' });
  return (key, values) => (t as unknown as ConsentT)(key, values);
}

/** An HTML page that no other origin may frame and no cache keeps. */
export function htmlPage(html: string, status = 200): Response {
  return new Response(html, { status, headers: CONSENT_PAGE_HEADERS });
}

/** The error page of app sign-in, in the user's language. */
export async function appLoginErrorPage(error: string, status: number, userId?: string | null): Promise<Response> {
  const locale = await appIdentityLocale(userId);
  return htmlPage(renderAppLoginError(await settingsT(locale), locale, error), status);
}

/** The public base for redirects behind the ingress (the container's own origin is unreachable from a browser). */
export function osPublicBase(fallbackOrigin: string): string {
  return config.osPublicUrl || fallbackOrigin;
}
