/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { proposePlan, approvePlan, type Mode, type PlanCompleter } from '@/lib/bigbets/planner';
import { principal, plannerHooks } from '@/lib/bigbets/server';
import { assistantComplete } from '@/lib/assistant/complete';

export const dynamic = 'force-dynamic';

/**
 * POST → the Big Bet planner.
 *   { action:'propose', goal }                       → a breakdown + dated roadmap
 *   { action:'approve', plan, mode, kickoff }         → scaffold each via its tab's
 *                                                       governed flow (never promotes)
 * OPA-gated + Langfuse-traced through the wired hooks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const POST = withRoute<{ id: string }, any>(async ({ user, params, body: b }) => {
    const { id } = params;

    // The planner runs on the ONE governed assistant LLM under the caller identity.
    const complete: PlanCompleter = async (messages) =>
      (await assistantComplete(messages, { user })).content;

    if (b.action === 'propose') {
      if (!b.goal?.trim()) return NextResponse.json({ error: 'A goal is required.' }, { status: 400 });
      return NextResponse.json(await proposePlan(b.goal, { complete }));
    }

    if (b.action === 'approve') {
      const plan = b.plan?.steps ? b.plan : await proposePlan(b.goal ?? '', { complete });
      const mode: Mode = b.mode === 'autonomous' ? 'autonomous' : 'in-tab';
      const result = await approvePlan(id, principal(user), plan, { mode, kickoff: b.kickoff, hooks: plannerHooks() });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "action must be 'propose' or 'approve'" }, { status: 400 });
}, { parse: true, defaultStatus: 500 });
