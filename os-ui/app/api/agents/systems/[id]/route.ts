/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { getSystem } from '@/lib/agents/store';
import { compile } from '@/lib/agents/langgraph-compile';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * GET → one system: its metadata, the parsed system.yaml, and (best-effort) the
 * compiled IR for the canvas. A compile error is returned alongside the system so
 * the canvas can still render the agents and surface the error inline.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const view = getSystem(id, user);
    let ir = null;
    let compileError: string | null = null;
    try {
      ir = compile(view.system);
    } catch (e) {
      compileError = (e as Error).message;
    }
    const canEdit = view.owner === user.id || (user.role === 'admin' && user.domains.includes(view.domain));
    return NextResponse.json({
      id: view.id,
      name: view.name,
      domain: view.domain,
      owner: view.owner,
      visibility: view.visibility,
      origin: view.origin,
      running: view.running,
      schedule: view.schedule,
      disabledAgents: view.disabledAgents,
      lastActivity: view.lastActivity,
      lastBuild: view.lastBuild ?? null,
      system: view.system,
      ir,
      compileError,
      canEdit,
      role: user.role,
      // Whether the Hermes autonomous runtime is provisioned in this deployment.
      // The runtime option is always SHOWN (per plan); when false, selecting it is
      // documented as gated-off (no gateway provisioned in base/kind).
      hermesEnabled: config.hermesEnabled,
    });
  } catch (e) {
    return fail(e);
  }
}
