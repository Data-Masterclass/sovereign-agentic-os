/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { getSystem, readFile, writeFile } from '@/lib/agents/store';
import { serializeSystem, SystemError, type System } from '@/lib/agents/system-schema';
import { applyInstruction, scaffoldSystem, type InstructionResult } from '@/lib/agents/assistant';
import { buildCatalog } from '@/lib/agents/tool-catalog';
import { assistantComplete } from '@/lib/assistant/complete';
import type { Role } from '@/lib/core/session';

export const dynamic = 'force-dynamic';

/**
 * Resolve the instruction into a system mutation: the deterministic
 * {@link applyInstruction} fast-path for the well-defined structured phrases, or
 * the governed-LLM {@link scaffoldSystem} fallback for a free-form description.
 * The LLM proposes STRUCTURE only; tools are auto-suggested within the caller's
 * role-floor catalog, never granted by the model.
 */
async function resolve(system: System, instruction: string, role: Role): Promise<InstructionResult> {
  try {
    return applyInstruction(system, instruction);
  } catch (e) {
    // Only the "unrecognised phrase" 400 falls through to the LLM scaffolder;
    // a real validation error (e.g. a bad handoff) is surfaced as-is.
    const unrecognised = e instanceof SystemError && /could not turn that into a system edit/i.test(e.message);
    if (!unrecognised) throw e;
    const catalog = buildCatalog(role).map((t) => t.name);
    return scaffoldSystem(system, instruction, {
      complete: (sys, user) => assistantComplete([
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ]).then((r) => r.content),
      catalog,
    });
  }
}

/**
 * POST → the agent-system helper. It edits the SAME system.yaml the canvas/Monaco
 * edit (via the store's writeFile), so the result is identical to the manual path
 * and a subsequent Build runs the same orchestrator. No separate code path.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<{ id: string }, any>(async ({ user, params, body }) => {
  const { id } = params;
  const instruction = typeof body.instruction === 'string' ? body.instruction : '';
  if (!instruction.trim()) return NextResponse.json({ error: 'An instruction is required.' }, { status: 400 });

  const view = getSystem(id, user);
  const { system, summary } = await resolve(view.system, instruction, user.role);
  const yaml = serializeSystem(system);

  // Commit through the same whitelisted, sha-checked file write.
  const current = readFile(id, user, 'system.yaml');
  writeFile(id, user, { path: 'system.yaml', content: yaml, sha: current.sha });

  return NextResponse.json({ summary, system });
}, { parse: true, defaultStatus: 500 });
