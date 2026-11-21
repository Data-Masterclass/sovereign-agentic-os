/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      Response headers for the MCP consent page
 * USER STORY:   As a user, no other page can embed the "Connect" consent screen and trick me into approving.
 * ARCHITECTURE: One constant used by every HTML response of app/(entry)/oauth/authorize/route.ts.
 */
/**
 * `frame-ancestors 'none'` (CSP Level 2) and `X-Frame-Options: DENY` (RFC 7034, for older
 * browsers) forbid every framing context; `no-store` keeps the per-user page out of caches.
 */
export const CONSENT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};
