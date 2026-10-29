/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The governed gateway chokepoint (Agent golden path §1). EVERY agent tool call
 * funnels through {@link invokeTool}: authorize (OPA) → run only if allowed →
 * trace (Langfuse), no exceptions. This is the PURE, dependency-injected core;
 * API routes wire in the real `authorize`/`trace` from `lib/agent-governed`,
 * while tests inject spies. There is deliberately NO code path that runs a tool
 * side effect without first authorizing and then tracing it — that invariant is
 * what makes Build's ✓ and the activity log real.
 */

export type Effect = 'allow' | 'deny' | 'requires_approval';
export type Decision = { effect: Effect; reason: string };

export type GwTrace = {
  principal: string;
  tool: string;
  input: unknown;
  output: unknown;
  decision: Effect;
};

export type Authorizer = (
  principal: string,
  tool: string,
  args?: Record<string, unknown>,
) => Decision | Promise<Decision>;

export type Tracer = (event: GwTrace) => void | Promise<void>;

export type Gateway = { authorize: Authorizer; trace: Tracer };

export type ToolCall<T> = {
  ok: boolean;
  decision: Decision;
  output: T | null;
  reason: string;
};

/**
 * Authorize, run-if-allowed, and ALWAYS trace a single tool call. Denied and
 * approval-gated calls never execute their side effect, but are still traced so
 * the attempt is auditable.
 */
export async function invokeTool<T>(
  gw: Gateway,
  principal: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  run: () => T | Promise<T>,
): Promise<ToolCall<T>> {
  const decision = await gw.authorize(principal, tool, args);
  if (decision.effect !== 'allow') {
    await gw.trace({ principal, tool, input: args ?? {}, output: { blocked: decision.reason }, decision: decision.effect });
    return { ok: false, decision, output: null, reason: decision.reason };
  }
  const output = await run();
  await gw.trace({ principal, tool, input: args ?? {}, output, decision: 'allow' });
  return { ok: true, decision, output, reason: decision.reason };
}
