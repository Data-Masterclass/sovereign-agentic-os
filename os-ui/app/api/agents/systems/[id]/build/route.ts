/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { getSystemForEdit, setLastBuild, setActivity, clearActivity } from '@tabs/agents/lib/store';
import { buildSystem } from '@tabs/agents/lib/build/server';
import { governYamlForOwner } from '@tabs/agents/lib/build/owner-grants';
import { agentKeyValue } from '@tabs/agents/lib/build/live-clients';
import { putSecret } from '@core/infra/secrets';
import { runWithSurface, uiSurfaceFor } from '@core/infra/request-surface';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → execute + verify the system across the 5 adapters; returns ✓/✗ rows.
 *
 * This route is hand-rolled (it owns a `finally` that clears the in-progress marker), so it sets
 * the request surface itself instead of inheriting it from `withRoute` — Part D: the build's
 * `setLastBuild` is a definition change and its commit must say `via ui:agents/systems/<id>/build`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return runWithSurface(uiSurfaceFor(req.url), () => build(ctx));
}

async function build(ctx: { params: Promise<{ id: string }> }) {
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
    // A3: a LIVE build minted (or confirmed) the system's own LiteLLM key. Write the value to the
    // secrets store ONCE and keep only its REFERENCE on the record; runs resolve it by reference and
    // fall back to the shared agent key when absent. Never the master key, never the value in a record.
    const keyRow = report.rows.find((r) => r.tool === 'litellm');
    const litellmKeyRef = report.mode === 'live' && keyRow?.status === 'ok'
      ? putSecret('agent-litellm-key', id, agentKeyValue(id))
      : view.lastBuild?.litellmKeyRef;
    // Persist the build outcome so it survives tab-switches, reloads, and redeploys.
    setLastBuild(id, user, { ok: report.ok, at: Date.now(), rows: report.rows, litellmKeyRef });
    return NextResponse.json(report);
  } catch (e) {
    return fail(e);
  } finally {
    if (id) clearActivity(id);
  }
}
