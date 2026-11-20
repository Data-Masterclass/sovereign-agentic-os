/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Platform Admin: see a refused os-data bundle and acknowledge it.
 * USER STORY: As an admin I want a real large removal (many users or tables deleted at once) to
 *             reach OPA only after I have looked at exactly what is removed and said yes.
 * ARCHITECTURE:
 *   - GET: the bundle status, including the refused compile (its content hash and the reasons).
 *   - POST {hash, reason}: one-shot acceptance of exactly that content (core/policy/bundle.ts);
 *     any other content is still judged by the guards. Admin only (requireAdmin) and an OPA
 *     decision (`authorize('user:<id>', 'admin')`), logged with the admin and the reason.
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@core/kernel/auth';
import { authorize } from '@core/infra/governed';
import { acknowledgeOsDataBundle, osDataBundleStatus, recompileOsData } from '@core/policy/bundle';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  await requireAdmin();
  return NextResponse.json(osDataBundleStatus());
}

export async function POST(req: Request): Promise<Response> {
  const user = await requireAdmin();
  const authz = await authorize(`user:${user.id}`, 'admin');
  if (!authz.allowed) return NextResponse.json({ error: 'forbidden', policy: authz.policy }, { status: 403 });
  let body: { hash?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch (err) {
    return NextResponse.json({ error: 'not JSON', detail: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const hash = typeof body.hash === 'string' ? body.hash : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!hash || !reason) return NextResponse.json({ error: 'hash and reason are required' }, { status: 400 });
  const ack = acknowledgeOsDataBundle(hash, user.id, reason);
  if (!ack.ok) return NextResponse.json({ error: ack.detail }, { status: 409 });
  const r = await recompileOsData('admin-acknowledged');
  return NextResponse.json({ acknowledged: true, compiled: r.ok, detail: r.ok ? r.bundle.revision : r.detail });
}
