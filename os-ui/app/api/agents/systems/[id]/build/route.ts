/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@core/kernel/auth';
import { getSystemForEdit, setLastBuild, setActivity, clearActivity, ensureSystemFolders } from '@tabs/agents/lib/store';
import { buildSystem } from '@tabs/agents/lib/build/server';
import { resolveAutoModelsForBuild } from '@tabs/agents/lib/build/model-choice-server';
import { governYamlForOwner } from '@tabs/agents/lib/build/owner-grants';
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
    // `model: auto` is decided here, once per Build, and stored in the definition before anything is keyed.
    const models = await resolveAutoModelsForBuild({ systemId: id, user, yaml: view.yaml });
    const yaml = await governYamlForOwner(models.yaml, view.owner);
    const built = await buildSystem(id, yaml);
    const report = models.row ? { ...built, rows: [models.row, ...built.rows] } : built;
    // The system's own LiteLLM key is minted, registered and stored (encrypted, in the durable key
    // store) INSIDE the build's `litellm` step — so every door that builds (this route, the MCP
    // tool) leaves the same result, and nothing about the key is kept on the system record.
    // Persist the build outcome so it survives tab-switches, reloads, and redeploys.
    setLastBuild(id, user, { ok: report.ok, at: Date.now(), rows: report.rows });
    // Safety net: the folders the definition names exist (Save already did this); a folder the
    // builder may not create comes back as a warning with the build result.
    const folders = ensureSystemFolders(id, user);
    return NextResponse.json({ ...report, folders });
  } catch (e) {
    return fail(e);
  } finally {
    if (id) clearActivity(id);
  }
}
