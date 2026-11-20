/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * GET /api/platform-admin/providers/migration — DRY RUN. For every model LiteLLM serves: its provider,
 * host, whether the egress proxy lets that host out, whether it is in the agent key's access group,
 * and the `/model/update` it WOULD get. Reads `/model/info`; sends nothing. Run it before the deploy
 * that puts the gateway behind the egress proxy: any `blockedHosts` entry must be allowlisted first.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { readProviderMigration } from '@tabs/admin/lib/llm-providers';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    const r = await readProviderMigration();
    if (!r.ok) return NextResponse.json({ error: r.message, code: r.code }, { status: r.status });
    return NextResponse.json(r.plan);
  } catch (e) {
    return fail(e);
  }
}
