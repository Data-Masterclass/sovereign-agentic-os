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
import { bundleHttpResponse, currentOsDataBundle, osDataBundleStatus } from '@core/policy/bundle';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!opaBearerOk(req.headers.get('authorization'))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const b = await currentOsDataBundle();
  if (!b) return Response.json({ error: 'no complete os-data bundle yet', detail: osDataBundleStatus().lastError }, { status: 503 });
  return bundleHttpResponse(b, req.headers.get('if-none-match'));
}
