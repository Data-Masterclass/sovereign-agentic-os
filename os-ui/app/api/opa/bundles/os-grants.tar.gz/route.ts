/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The long-polled os-grants bundle endpoint.
 * USER STORY: As a user starting a run I want my run grant in OPA within two seconds, and never an empty grant set when the database is down.
 * ARCHITECTURE:
 * The `os-grants` bundle service endpoint with HTTP long polling (core/policy/grants-bundle.ts):
 * a request whose If-None-Match is the current revision and that sends `Prefer: wait=<s>` is held
 * until the grant revision moves (then the new bundle) or the wait ends (304). A database that
 * cannot be read is a 503: OPA keeps its last good bundle, never an empty grant set.
 */
import { opaBearerOk } from '@core/policy/bundle-auth';
import { bundleHttpResponse } from '@core/policy/bundle';
import { BUNDLE_CONTENT_TYPE, currentOsGrantsBundle, preferWaitMs, waitForGrantChange } from '@core/policy/grants-bundle';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!opaBearerOk(req.headers.get('authorization'))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const inm = req.headers.get('if-none-match');
  try {
    let b = await currentOsGrantsBundle();
    const waitMs = preferWaitMs(req.headers.get('prefer'));
    if (inm && inm.includes(b.etag) && waitMs > 0) {
      if (await waitForGrantChange(b.revision, waitMs)) b = await currentOsGrantsBundle();
    }
    return bundleHttpResponse(b, inm, BUNDLE_CONTENT_TYPE);
  } catch (err) {
    console.error(`[os-ui] os-grants bundle: not served — ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: 'os-grants bundle unavailable' }, { status: 503 });
  }
}
