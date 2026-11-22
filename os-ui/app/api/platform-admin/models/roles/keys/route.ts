/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Preview or run the migration that adds the three role names to the keys the OS owns.
 * USER STORY: As a platform admin I see which agent keys lack the role names (dry run) and fix them without a rebuild.
 * ARCHITECTURE: logic in `tabs/agents/lib/build/role-key-migration.ts`; wiring in `role-key-migration-live.ts`.
 *
 * POST /api/platform-admin/models/roles/keys — body `{ "dryRun": true }` only reports the plan. Admin only. Adds only,
 *      never removes or changes a key value, touches only keys the OS owns, audited per change. Idempotent. It also
 *      runs by itself at boot.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../../_ctx';
import { authorize } from '@core/infra/governed';
import { migrateRoleKeysLive } from '@tabs/agents/lib/build/role-key-migration-live';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { user } = await adminCtx();
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
    const r = await migrateRoleKeysLive({ dryRun, actor: user.id });
    return NextResponse.json(r, { status: r.ok ? 200 : 502 });
  } catch (e) {
    return fail(e);
  }
}
