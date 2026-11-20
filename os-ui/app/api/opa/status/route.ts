/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OPA's status-report receiver.
 * USER STORY: As a user starting a run I want the OS to know which grant revision each OPA has activated, so it waits on proof, not on time.
 * ARCHITECTURE:
 * OPA's status service endpoint (`status: {service: osui}` → POST <service url>/status,
 * https://www.openpolicyagent.org/docs/management-status). Stores each instance's active bundle
 * revisions (core/policy/opa-status.ts) once OPA's own policy allows the report. GET returns them for the run worker and Monitoring.
 */
import { authorize } from '@core/infra/governed';
import { opaBearerOk } from '@core/policy/bundle-auth';
import { opaInstanceStatuses, recordOpaStatus } from '@core/policy/opa-status';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  if (!opaBearerOk(req.headers.get('authorization'))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // The report itself is an OPA decision too: principal `opa-status-reporter` holds the tool
  // `opa_status_report` by chart seed grant (values opa.grants). A denied or unreachable decision
  // is a 403, and a run that waits on this report then fails closed (grant_not_propagated).
  const authz = await authorize('opa-status-reporter', 'opa_status_report');
  if (!authz.allowed) return Response.json({ error: 'forbidden', policy: authz.policy }, { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return Response.json({ error: 'not JSON', detail: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const instance = recordOpaStatus(body);
  if (!instance) return Response.json({ error: 'not an OPA status report' }, { status: 400 });
  return new Response(null, { status: 204 });
}

export async function GET(req: Request): Promise<Response> {
  if (!opaBearerOk(req.headers.get('authorization'))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return Response.json({ instances: opaInstanceStatuses() });
}
