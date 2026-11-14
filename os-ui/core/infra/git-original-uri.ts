/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       infra / engineer's door
 * FEATURE:    Recover the original git request path inside the ingress auth sub-request
 * USER STORY: As an engineer I want `git clone https://<os>/git/<domain>.git` to authenticate on
 *             a cluster whose ingress-nginx has snippet directives disabled, so the OS must read
 *             the headers the controller sends by DEFAULT rather than one a snippet would add.
 * ARCHITECTURE:
 *   - ingress-nginx's `auth-url` sub-request always carries `X-Original-URL` (absolute URL) and
 *     `X-Original-Method`. `X-Original-URI` only exists when an `auth-snippet` sets it, and the
 *     STACKIT controller refuses snippets (`allow-snippet-annotations: false`, 2026-11-14).
 *   - Order: X-Original-URL (path + query) → X-Original-URI → explicit `?uri=` (tests, curl).
 *   - Pure; never throws on a malformed URL — a bad header reads as "no path", which the
 *     authenticator then refuses as it does today.
 */

export type HeaderReader = { get(name: string): string | null };

/** The path (+ query) of the request the ingress is asking us to authorise, or ''. */
export function originalRequestUri(headers: HeaderReader, requestUrl: string): string {
  const absolute = headers.get('x-original-url');
  if (absolute) {
    try {
      const u = new URL(absolute);
      return `${u.pathname}${u.search}`;
    } catch {
      /* fall through to the other sources */
    }
  }
  const relative = headers.get('x-original-uri');
  if (relative) return relative;
  try {
    return new URL(requestUrl).searchParams.get('uri') || '';
  } catch {
    return '';
  }
}
