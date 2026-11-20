/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The os-data bundle endpoint OPA polls.
 * USER STORY: As an operator I want OPA to fetch policy data from os-ui itself, with ETag/304, and get nothing until a complete bundle exists.
 * ARCHITECTURE:
 * The `os-data` bundle service endpoint OPA polls (core/policy/bundle.ts). 304 on a matching
 * ETag; 503 until a first complete compile exists, so a cold OPA stays unready (fail closed).
 */
import { opaBearerOk } from '@core/policy/bundle-auth';
import { bundleHttpResponse, currentOsDataBundle, olderThanActive, osDataBundleStatus, recompileOsData } from '@core/policy/bundle';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!opaBearerOk(req.headers.get('authorization'))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const b = await currentOsDataBundle();
  if (!b) return Response.json({ error: 'no complete os-data bundle yet', detail: osDataBundleStatus().lastError }, { status: 503 });
  const inm = req.headers.get('if-none-match');
  // Never hand an OPA a bundle older than the one it has active (this pod is behind).
  if (olderThanActive(b, inm)) {
    void recompileOsData('behind-active');
    return Response.json({ error: 'this os-ui holds an older os-data bundle than the one OPA has active', active: inm, served: b.revision }, { status: 409 });
  }
  // OPA already holds this exact content (perhaps under a higher sequence from another pod).
  if (b.hash && inm?.includes(`-${b.hash}`)) return new Response(null, { status: 304, headers: { ETag: inm } });
  return bundleHttpResponse(b, inm);
}
