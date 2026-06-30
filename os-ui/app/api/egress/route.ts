/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { requestEgress, listEgressRequests, egressLog } from '@/lib/egress-requests';
import { egressHost } from '@/lib/secrets';

export const dynamic = 'force-dynamic';

/** List egress requests for the caller's domains + the recent outbound log. */
export async function GET() {
  try {
    const user = await requireUser();
    const requests = user.domains.flatMap((d) => listEgressRequests({ domain: d }));
    return NextResponse.json({ user, requests, log: egressLog(50) });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/**
 * A Builder REQUESTS egress to a new endpoint host (default-deny). An Admin
 * approves it elsewhere. Body: { host | endpoint, reason }.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (user.role !== 'builder' && user.role !== 'admin') {
      return NextResponse.json({ error: 'Requesting egress requires a Builder or Administrator' }, { status: 403 });
    }
    const body = await req.json();
    const raw = String(body?.host ?? body?.endpoint ?? '').trim();
    if (!raw) return NextResponse.json({ error: 'A host or endpoint is required' }, { status: 400 });
    const host = egressHost(raw);
    const r = requestEgress({ host, domain: user.domains[0], reason: String(body?.reason ?? ''), requestedBy: user.id });
    return NextResponse.json({ request: r }, { status: 201 });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
