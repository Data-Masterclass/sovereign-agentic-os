/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { listCaps, setCap, type CapScope } from '@/lib/governance/cost';
import { record as audit } from '@/lib/governance/audit';
import { roleAtLeast } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Cost & limits (§4). GET = the caps in scope; POST = SET a cap (a policy
 * action — Admin sets tenant/key caps, Builder sets caps within own domain).
 * Live spend lives in Monitoring; this tab sets the limit.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const scope = user.role === 'admin' ? undefined : user.domains;
  return NextResponse.json({ caps: listCaps(scope), canSet: roleAtLeast(user.role, 'builder') });
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  if (!roleAtLeast(user.role, 'builder')) {
    return NextResponse.json({ error: 'Setting a cap needs a Builder or Admin' }, { status: 403 });
  }
  let body: { scope?: CapScope; subject?: string; limit?: number; period?: 'day' | 'month'; modelClass?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const scope = (['key', 'domain', 'tenant'].includes(String(body?.scope)) ? body.scope : 'domain') as CapScope;
  const subject = String(body?.subject ?? '').trim();
  const limit = Number(body?.limit);
  if (!subject || !Number.isFinite(limit) || limit < 0) {
    return NextResponse.json({ error: 'subject + non-negative numeric limit required' }, { status: 400 });
  }
  // Non-admins (Builder / Domain admin) may only cap within their own domain;
  // tenant/key caps stay (platform) Admin-only.
  if (user.role !== 'admin' && (scope !== 'domain' || !user.domains.includes(subject))) {
    return NextResponse.json({ error: 'Builders and Domain admins may only cap their own domain' }, { status: 403 });
  }
  const cap = setCap({ scope, subject, limit, period: body?.period, modelClass: body?.modelClass, createdBy: user.id });
  audit({
    actor: user.id,
    action: 'cost.cap.set',
    subject: `${scope}:${subject}`,
    domain: scope === 'domain' ? subject : 'tenant',
    reason: `Set ${cap.period} cap ${limit}${cap.modelClass ? ` (${cap.modelClass})` : ''} on ${scope} ${subject}`,
    detail: { ...cap },
  });
  return NextResponse.json({ cap }, { status: 201 });
}
