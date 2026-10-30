/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    GET the reconcile plan, POST to apply it. Admin only.
 *
 * USER STORY: As a platform admin I preview every change the OS would make to
 *             the gateway, then apply it in one action, and I am told which
 *             operations failed rather than being left guessing.
 *
 * ARCHITECTURE:
 *   Gated by `adminCtx()`, the same chokepoint as every Platform-Admin route.
 *
 *   SECURITY: POST does NOT accept a plan from the client. It recomputes the
 *   plan server-side and applies that. Accepting ops over the wire would let
 *   any admin session post arbitrary endpoints and payloads to LiteLLM's admin
 *   API, turning this route into a confused-deputy proxy for the master key.
 *   The client's role is to look at the plan and say "apply", nothing more.
 *
 *   Drift is never applied — `applyReconcile` ignores that list by design, so
 *   no request shape can cause a hand-made team or key to be modified.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { planReconcile, applyReconcile } from '@tabs/admin/lib/litellm-reconcile';

export const dynamic = 'force-dynamic';

/** What the OS would change. Reads only. */
export async function GET() {
  try {
    await adminCtx();
  } catch (e) {
    return fail(e);
  }
  return NextResponse.json(await planReconcile());
}

/** Apply the SERVER-COMPUTED plan. The request body is deliberately ignored. */
export async function POST() {
  let ctx;
  try {
    ctx = await adminCtx();
  } catch (e) {
    return fail(e);
  }
  const plan = await planReconcile();
  // A plan built from an unreadable gateway would "create" everything that the
  // gateway already has but could not be listed. Refuse rather than duplicate.
  if (plan.degraded) {
    return NextResponse.json(
      { error: 'The gateway could not be read, so the plan is not trustworthy. Nothing was applied.' },
      { status: 503 },
    );
  }
  const result = await applyReconcile(plan);
  return NextResponse.json({ ...result, by: ctx.user.id, planned: plan.creates.length + plan.updates.length });
}
