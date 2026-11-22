/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Carry the old per-role model setting into `os/models.yml`, with a dry run.
 * USER STORY: As a platform admin I preview and run the one-time move from the old role dropdowns to the role mapping file.
 * ARCHITECTURE: logic in `core/models/role-seed.ts`; wiring in `role-seed-live.ts`.
 *
 * POST /api/platform-admin/models/roles/migrate — carry the old per-role model setting (and, failing that, the
 *      chart seed) into `os/models.yml` once. Body `{ "dryRun": true }` only reports what it would write.
 *      Admin only; audited when it writes. Idempotent: when the file already exists nothing is changed
 *      (`state: "already-mapped"`). Runs by itself at boot; this is the manual, previewable form.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../../_ctx';
import { authorize } from '@core/infra/governed';
import { audit } from '@tabs/admin/lib/audit';
import { seedRoleMappingLive } from '@tabs/admin/lib/role-seed-live';
import { reconcileRoleMapping } from '@core/models/role-reconcile';
import { liveRoleIo } from '@core/models/role-live';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed) return NextResponse.json({ error: `Policy did not allow this admin action (${authz.policy}).`, code: 'policy_denied' }, { status: 403 });
    let dryRun = false;
    const raw = await req.text(); // no body = a real run
    if (raw.trim()) {
      try {
        dryRun = (JSON.parse(raw) as { dryRun?: unknown })?.dryRun === true;
      } catch {
        return NextResponse.json({ error: 'The request body must be JSON: {"dryRun": true} or empty' }, { status: 400 });
      }
    }
    const r = await seedRoleMappingLive({ by: user.id, dryRun });
    if (!dryRun && (r.state === 'seeded' || r.state === 'migrated')) {
      audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'models.roles.set', target: 'models:roles', detail: `Created os/models.yml from ${r.state === 'migrated' ? 'the old role setting' : 'the chart seed'} (${JSON.stringify(r.sources)}).`, data: { mapping: r.mapping } });
      await reconcileRoleMapping(liveRoleIo());
    }
    return NextResponse.json(r, { status: r.state === 'unreadable' ? 502 : 200 });
  } catch (e) {
    return fail(e);
  }
}
