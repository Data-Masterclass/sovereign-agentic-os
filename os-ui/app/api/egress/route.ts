/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { withRoute, apiError } from '@core/kernel/route-server';
import { errorBodyOf } from '@core/kernel/server-message';
import { requestEgress, listEgressRequests, egressLog, ensureHydrated } from '@tabs/connections/lib/index';
import { egressHost } from '@core/infra/secrets';
import { roleAtLeast } from '@core/kernel/session';

export const dynamic = 'force-dynamic';

/** List egress requests for the caller's domains + the recent outbound log. */
export const GET = withRoute(async ({ user }) => {
  const requests = user.domains.flatMap((d) => listEgressRequests({ domain: d }));
  return NextResponse.json({ user, requests, log: egressLog(50) });
}, { hydrate: ensureHydrated, defaultStatus: 500 });

/**
 * A Builder REQUESTS egress to a new endpoint host (default-deny). An Admin
 * approves it elsewhere. Body: { host | endpoint, reason }.
 */
export async function POST(req: Request) {
  try {
    await ensureHydrated();
    const user = await requireUser();
    if (!roleAtLeast(user.role, 'builder')) {
      return apiError(403, 'Requesting egress requires a Builder or Administrator', 'egress.needsBuilder');
    }
    const body = await req.json();
    const raw = String(body?.host ?? body?.endpoint ?? '').trim();
    if (!raw) return apiError(400, 'A host or endpoint is required', 'egress.hostRequired');
    const host = egressHost(raw);
    const r = requestEgress({ host, domain: user.domains[0], reason: String(body?.reason ?? ''), requestedBy: user.id });
    return NextResponse.json({ request: r }, { status: 201 });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json(errorBodyOf(e), { status });
  }
}
