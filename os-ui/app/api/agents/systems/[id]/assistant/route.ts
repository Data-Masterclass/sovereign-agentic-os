/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getSystem, readFile, writeFile } from '@/lib/agents/store';
import { serializeSystem } from '@/lib/agents/system-schema';
import { applyInstruction } from '@/lib/agents/assistant';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → the agent-system helper. It edits the SAME system.yaml the canvas/Monaco
 * edit (via the store's writeFile), so the result is identical to the manual path
 * and a subsequent Build runs the same orchestrator. No separate code path.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const instruction = typeof body.instruction === 'string' ? body.instruction : '';
    if (!instruction.trim()) return NextResponse.json({ error: 'An instruction is required.' }, { status: 400 });

    const view = getSystem(id, user);
    const { system, summary } = applyInstruction(view.system, instruction);
    const yaml = serializeSystem(system);

    // Commit through the same whitelisted, sha-checked file write.
    const current = readFile(id, user, 'system.yaml');
    writeFile(id, user, { path: 'system.yaml', content: yaml, sha: current.sha });

    return NextResponse.json({ summary, system });
  } catch (e) {
    return fail(e);
  }
}
