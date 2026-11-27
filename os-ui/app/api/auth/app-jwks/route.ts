/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (E) - the public keys of the app identity token (JWKS)
 * USER STORY: As an app developer I can verify that a token came from this OS, and keys can rotate without downtime.
 * ARCHITECTURE: GET only, public halves of every key in `os-app-token-key` (kid selects); 503 when no key is mounted
 *               (fail closed). `app_builder_disabled` while the App Builder is off.
 */
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { AppTokenUnavailable, appTokenJwks } from '@core/auth/app-token';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  try {
    return Response.json(await appTokenJwks(), { headers: { 'cache-control': 'public, max-age=300' } });
  } catch (e) {
    if (e instanceof AppTokenUnavailable) return Response.json({ error: e.code, reason: e.message }, { status: 503 });
    throw e;
  }
}
