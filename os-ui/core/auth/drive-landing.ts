/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Where the Drive/OneDrive OAuth callback sends the user, and the
 *             provider error code it is allowed to forward.
 *
 * USER STORY: As someone connecting OneDrive, finishing consent lands me on the
 *             Files tab rather than a 404. As an operator debugging a failure, I
 *             get the provider's real code instead of a generic label.
 *
 * ARCHITECTURE:
 *   A plain module, not part of the route, for two reasons. A Next.js `route.ts`
 *   may only export its HTTP handlers and a short list of config names, so
 *   exporting helpers from one breaks the build's type contract. And a test
 *   cannot import a route at all — it pulls `next/headers` transitively. Keeping
 *   the logic here is what makes the invariant testable, which is the whole
 *   point: the original bug was an untested constant drifting from the nav.
 */
import { TABS } from '@core/kernel/tabs';

/**
 * The Files tab's REAL route. It is `/unstructured`; `/files` exists only as an
 * API path and has no page, so every exit of the OAuth callback — success
 * included — used to land on a 404. Derived from the nav so it cannot drift:
 * rename the tab and this follows.
 */
export const FILES_LANDING_PATH: string =
  TABS.find((t) => t.feature === 'files')?.href ?? '/unstructured';

/**
 * Pull a SAFE, useful code out of a provider error.
 *
 * Providers put the actual cause in a code — `AADSTS7000215` is a bad client
 * secret, `AADSTS50194` is a single-tenant app on the `/common` endpoint — and
 * the OS used to discard all of it, leaving a generic `exchange_failed` that
 * cannot distinguish a mistyped secret from an unreachable endpoint.
 *
 * Only a MATCHED code is returned. Free text is never forwarded, because a
 * provider body can echo request material and this value lands in a URL.
 */
export function safeErrorCode(text: string): string {
  // 4-8 digits: real codes run from AADSTS50011 to AADSTS7000215, and a {4,6}
  // cap silently TRUNCATED the 7-digit ones into a code that does not exist.
  const aad = /AADSTS\d{4,8}/.exec(text);
  if (aad) return aad[0];
  const code = /\b(invalid_client|invalid_grant|invalid_request|invalid_scope|unauthorized_client|unsupported_grant_type|redirect_uri_mismatch|access_denied)\b/.exec(text);
  return code ? code[1] : '';
}
