/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Content-Security-Policy for the OS's own pages
 * USER STORY: As a user, even if something on a page tries to load an image or media file from
 *             another site, my browser refuses, so nothing I am looking at can leak data that way.
 * ARCHITECTURE:
 *   - Set by middleware.ts on page responses only. ENFORCED: img-src + media-src ('self', data:,
 *     blob: — dashboards/workflow views draw charts as blob:/data: images; files preview from
 *     /api/files/<id>/raw, same-origin). REPORT-ONLY: a fuller policy (connect/frame/frame-ancestors
 *     …) so violations show in the browser console before anything wider is enforced.
 *   - NOT applied to /tools/* (proxied third-party UIs keep their own, rewritten, CSP — see
 *     core/infra/tool-proxy.ts), /api/* (routes such as the app runtime and file raw set their own
 *     CSP and must not be overridden), /oauth/* (consent page sets frame-ancestors 'none') or
 *     Next internals.
 *   - A framed document gets its own CSP from its own response, so the page's img-src never
 *     constrains an embedded tool or the software-preview iframe.
 */

/** Enforced on every OS page: no image or media request to any other origin. */
export const PAGE_CSP_ENFORCED = "img-src 'self' data: blob:; media-src 'self' data: blob:";

/** Observed only (console reports): the wider policy we intend to enforce once it is quiet. */
export function pageCspReportOnly(appsBaseDomain?: string): string {
  const appsFrame = appsBaseDomain && /^[a-z0-9.-]+$/i.test(appsBaseDomain) ? ` https://*.${appsBaseDomain}` : '';
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    `frame-src 'self'${appsFrame}`,
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Which request paths get the page CSP (pages only — see the header for the exclusions). */
export function pageCspAppliesTo(pathname: string): boolean {
  return !(
    pathname.startsWith('/api/') ||
    pathname.startsWith('/tools/') ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/.well-known/') ||
    pathname.startsWith('/_next')
  );
}

/** Headers to add to a page response. */
export function pageCspHeaders(appsBaseDomain?: string): Record<string, string> {
  return {
    'Content-Security-Policy': PAGE_CSP_ENFORCED,
    'Content-Security-Policy-Report-Only': pageCspReportOnly(appsBaseDomain),
  };
}
