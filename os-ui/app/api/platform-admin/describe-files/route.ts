/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx } from '../_ctx';
import { audit } from '@tabs/admin/lib/audit';
import { effectiveModelPrices } from '@tabs/admin/lib/model-prices';
import { getSettings } from '@tabs/admin/lib/settings';
import { ensureHydrated as ensureFilesHydrated } from '@tabs/files/lib/store';
import { planDescribe, runDescribe } from '@tabs/files/lib/pipeline-server';

export const dynamic = 'force-dynamic';

/**
 * ADMIN: describe the existing files that have text but no description or tags — the door behind
 * Platform → Re-index → "Describe existing files".
 *
 *   GET   the DRY RUN: how many files a run would send to the model, how many are left alone and
 *         why, and an ESTIMATED token count and cost from the price book. Writes nothing and
 *         calls no model.
 *   POST  { batch, after }  ONE bounded batch, billed to the admin who calls it. Returns a
 *         `cursor` to pass back as `after`; calling with no cursor starts over, which is safe —
 *         a file that already has a description is not a candidate any more.
 *
 * Gated by `adminCtx()` and re-checked in-lib; every decision lives in
 * `tabs/files/lib/describe.ts`, which is tested (a route cannot be imported by a test).
 */
function errorResponse(e: unknown): NextResponse {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

export async function GET() {
  try {
    const { user } = await adminCtx();
    await ensureFilesHydrated();
    const prices = await effectiveModelPrices();
    const plan = await planDescribe({ id: user.id, role: user.role }, (model) => prices[model]);
    return NextResponse.json({ plan: { ...plan, estimate: { ...plan.estimate, currency: getSettings().currency } } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    await ensureFilesHydrated();
    const body = (await req.json().catch(() => ({}))) as { batch?: unknown; after?: unknown };
    const run = await runDescribe(
      { id: user.id, role: user.role },
      { batch: typeof body.batch === 'number' ? body.batch : undefined, after: typeof body.after === 'string' && body.after ? body.after : null },
    );
    audit({
      tenant: tenant.id, actor: user.id, role: user.role, action: 'files.describe.run', target: 'files',
      detail: run.started
        ? `Described existing files: ${run.described} written, ${run.failures.length} failed, ${run.skipped} skipped, ${run.remaining} left${run.reason ? ` — stopped: ${run.reason}` : ''}`
        : `Did not run: ${run.reason}`,
      guarded: true,
    });
    return NextResponse.json({ run });
  } catch (e) {
    return errorResponse(e);
  }
}
