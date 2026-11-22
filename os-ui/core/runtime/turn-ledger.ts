/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    The per-turn model trace: which role and model handled each step, and what each role cost
 * USER STORY: As an admin I open a turn and see that planning and the answer ran on the strong model,
 *             that a table was condensed on the worker, and what each of the two cost.
 * ARCHITECTURE:
 *   - `ledger.wrap(llm)` records every model call of the turn as it completes: its purpose
 *     (`plan`, `act`, `synthesis`, `delegate:<task>`), the model, the role the model stands for and the
 *     usage the gateway REPORTED. Nothing is estimated here.
 *   - `priceTrace` turns usage into cost with the catalog prices (EUR per 1M tokens per model_name,
 *     `tabs/admin/lib/model-prices.ts`). A call with no reported usage, or a model with no price, books
 *     NO cost: the role's cost is then `undefined` ("—"), never a made-up zero.
 *   - Pure (no `server-only`): the wiring supplies the role of a model and the prices.
 */
import type { LlmCall, LlmUsage } from '@core/runtime/agentic';

export type TraceRole = 'strong' | 'worker' | 'pinned';
export const TRACE_ROLES: readonly TraceRole[] = ['strong', 'worker', 'pinned'];

export type TurnCall = {
  n: number;
  purpose: string;
  role: TraceRole;
  model: string;
  /** A worker sub-task whose answer failed its schema and was redone on strong. */
  escalated: boolean;
  /** The delegation this call belongs to (see `ModelTrace.delegations`). */
  delegation?: number;
  usage?: LlmUsage;
};
/** One `delegate_to_worker` decision: what strong asked for, who answered, and what came back. */
export type TurnDelegation = {
  id: number; instruction: string; preset?: string; schemaKeys: string[]; inputs: string[];
  role: 'worker' | 'strong'; model: string; escalated: boolean; ms: number; resultPreview: string;
};
export type ModelTrace = { calls: TurnCall[]; delegations: TurnDelegation[] };

export type RoleTotals = { calls: number; input: number; output: number; cost?: number };
export type PricedTrace = {
  calls: (TurnCall & { cost?: number })[];
  delegations: (TurnDelegation & { cost?: number })[];
  byRole: Record<TraceRole, RoleTotals>;
  cost?: number;
};
export type Prices = Record<string, { inputPerM: number; outputPerM: number }>;

export type TurnLedger = { wrap: (inner: LlmCall) => LlmCall; addDelegation: (d: TurnDelegation) => void; trace: () => ModelTrace };

export function createTurnLedger(roleOf: (model: string) => TraceRole): TurnLedger {
  const calls: TurnCall[] = [];
  const delegations: TurnDelegation[] = [];
  return {
    addDelegation: (d) => { delegations.push(d); },
    wrap: (inner) => async (req) => {
      const completion = await inner(req);
      calls.push({
        n: calls.length + 1,
        purpose: req.purpose ?? 'act',
        role: roleOf(req.model),
        model: req.model,
        escalated: req.escalated === true,
        ...(req.delegationId !== undefined ? { delegation: req.delegationId } : {}),
        ...(completion.usage ? { usage: completion.usage } : {}),
      });
      return completion;
    },
    trace: () => ({ calls: calls.map((c) => ({ ...c })), delegations: delegations.map((d) => ({ ...d })) }),
  };
}

export function priceTrace(trace: ModelTrace, prices: Prices): PricedTrace {
  const byRole = Object.fromEntries(TRACE_ROLES.map((r) => [r, { calls: 0, input: 0, output: 0 } as RoleTotals])) as Record<TraceRole, RoleTotals>;
  const unpriced = new Set<TraceRole>();
  const calls: PricedTrace['calls'] = trace.calls.map((c) => {
    const t = byRole[c.role];
    t.calls += 1;
    t.input += c.usage?.input ?? 0;
    t.output += c.usage?.output ?? 0;
    const p = prices[c.model];
    if (!c.usage || !p) { unpriced.add(c.role); return { ...c }; }
    const cost = (c.usage.input * p.inputPerM + c.usage.output * p.outputPerM) / 1e6;
    t.cost = (t.cost ?? 0) + cost;
    return { ...c, cost };
  });
  for (const r of unpriced) byRole[r].cost = undefined; // one unpriced call makes the role's total unknown
  for (const r of TRACE_ROLES) if (byRole[r].calls === 0) byRole[r].cost = 0;
  const known = TRACE_ROLES.filter((r) => byRole[r].calls > 0);
  const cost = known.every((r) => byRole[r].cost !== undefined) ? known.reduce((a, r) => a + (byRole[r].cost ?? 0), 0) : undefined;
  const delegations = trace.delegations.map((d) => {
    const mine = calls.filter((c) => c.delegation === d.id);
    return mine.length > 0 && mine.every((c) => c.cost !== undefined) ? { ...d, cost: mine.reduce((a, c) => a + (c.cost ?? 0), 0) } : { ...d };
  });
  return { calls, delegations, byRole, ...(cost !== undefined ? { cost } : {}) };
}
