/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getSystemForEdit, setLastBuild, setActivity, clearActivity } from '@/lib/agents/store';
import { buildSystem } from '@/lib/agents/build/server';
import { governYamlForOwner } from '@/lib/agents/build/owner-grants';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/** POST → execute + verify the system across the 5 adapters; returns ✓/✗ rows. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let id: string | undefined;
  let user: Awaited<ReturnType<typeof requireUser>> | undefined;
  try {
    user = await requireUser();
    ({ id } = await ctx.params);
    // Build executes the system + lands Langfuse traces (a side effect into
    // shared Monitoring), so it is edit-level, consistent with Run/Probe.
    const view = getSystemForEdit(id, user);
    // Mark in-progress so a returning user sees "building since…" not a blank slate.
    setActivity(id, { kind: 'building', startedAt: Date.now() });
    // Re-assert the builder-gate against the OWNER's CURRENT role (S1): a stale
    // direct-write grant is downgraded to held-for-approval before it compiles
    // into live OPA/LiteLLM policy.
    const yaml = await governYamlForOwner(view.yaml, view.owner);
    const report = await buildSystem(id, yaml);
    // Persist the build outcome so it survives tab-switches, reloads, and redeploys.
    setLastBuild(id, user, { ok: report.ok, at: Date.now(), rows: report.rows });
    return NextResponse.json(report);
  } catch (e) {
    return fail(e);
  } finally {
    if (id) clearActivity(id);
  }
}
