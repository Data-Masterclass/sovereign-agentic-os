/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../../_ctx';
import { audit } from '@tabs/admin/lib/audit';
import { domainsMissingOwnedFiles } from '@core/infra/owned-files';
import { reconcileOneDomain } from '@tabs/data/lib/dbt/boot-reconcile';

export const dynamic = 'force-dynamic';

/** GET → does this domain's repo lack the OS's list of generated files (the receive gate fails closed for models/ and tests/)? */
export async function GET(_req: Request, ctx: { params: Promise<{ domain: string }> }) {
  try {
    await adminCtx();
    const { domain } = await ctx.params;
    return NextResponse.json({ domain, ownedFilesMissing: (await domainsMissingOwnedFiles()).includes(domain) });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST → reconcile ONE domain now (admin only): the boot reconcile's whole-tree commit for that domain,
 * which writes `os/owned-files.yml`. A reconcile that could not run (DATA_PROJECT_GIT off, registry not
 * hydrated) answers 409 with the reason; it is never reported as done.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ domain: string }> }) {
  try {
    const { user, tenant } = await adminCtx();
    const { domain } = await ctx.params;
    const out = await reconcileOneDomain(domain);
    if (!out.ran) {
      return NextResponse.json({ error: 'the reconcile did not run: DATA_PROJECT_GIT is off or the dataset registry is not hydrated (see the os-ui log)' }, { status: 409 });
    }
    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'data-project.reconcile', target: `domain:${domain}`, detail: out.committed.length ? `Committed ${out.committed[0].sha.slice(0, 7)}` : 'Nothing to commit' });
    return NextResponse.json({ domain, committed: out.committed, failed: out.failed });
  } catch (e) {
    return fail(e);
  }
}
