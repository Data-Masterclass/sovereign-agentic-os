/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/core/auth';
import { verifyChain } from '@/lib/governance/audit';
import { ensureHydrated, listAudit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

/**
 * Audit (§3) — the ONE durable trail. Reads the PERSISTENT Admin audit store
 * (the same os-audit ring both Platform Admin and Governance surface), so the
 * feed survives restarts and never runs a parallel in-memory log. Governance
 * write-throughs carry a `governance.` action prefix and a `[domain:x]` prefix
 * on the detail; both are normalised back into the view shape here.
 *
 * Scoped: Admin = tenant-wide, Builder = own domains. The tamper-evident chain
 * status (from the governance integrity view) is returned so the UI can show it.
 */
type ViewEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  subject: string;
  domain: string;
  reason: string;
  detail: unknown;
};

const DOMAIN_RE = /^\[domain:([^\]]*)\]\s?/;

function normalise(e: {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
}): ViewEntry {
  const gov = e.action.startsWith('governance.');
  const m = e.detail.match(DOMAIN_RE);
  const domain = m ? m[1] : 'tenant';
  const reason = m ? e.detail.replace(DOMAIN_RE, '') : e.detail;
  return {
    id: e.id,
    at: e.ts,
    actor: e.actor,
    action: gov ? e.action.slice('governance.'.length) : e.action,
    subject: e.target,
    domain,
    reason,
    detail: {},
  };
}

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  await ensureHydrated();

  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim().toLowerCase();
  const action = url.searchParams.get('action') || undefined;

  const rows = listAudit({ limit: 500 }).map(normalise);
  // Builder scope: only their domains. Admin sees the whole tenant. Tenant-scoped
  // (domain-less) Admin entries stay visible to everyone with audit access.
  const scoped = user.role === 'admin'
    ? rows
    : rows.filter((e) => e.domain === 'tenant' || user.domains.includes(e.domain));

  const entries = scoped
    .filter((e) => (action ? e.action === action : true))
    .filter((e) =>
      q
        ? `${e.actor} ${e.action} ${e.subject} ${e.reason} ${e.domain}`.toLowerCase().includes(q)
        : true,
    );

  const broken = verifyChain();
  return NextResponse.json({ entries, broken, intact: broken === null });
}
