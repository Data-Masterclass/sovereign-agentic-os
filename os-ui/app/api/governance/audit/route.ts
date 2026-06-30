/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { search, verifyChain, type AuditAction } from '@/lib/governance/audit';

export const dynamic = 'force-dynamic';

/**
 * Audit (§3). The searchable record of who did/approved what, when, on which
 * inputs. Scoped: Admin = tenant-wide, Builder = own domains. Returns the
 * tamper-evident chain status so the UI can show integrity.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? undefined;
  const action = (url.searchParams.get('action') as AuditAction) || undefined;
  const domains = user.role === 'admin' ? undefined : user.domains;
  const entries = search({ q, action, domains });
  return NextResponse.json({ entries, broken: verifyChain(), intact: verifyChain() === null });
}
