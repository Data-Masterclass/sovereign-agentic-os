/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Cost & limits (governance-golden-path.md §4) — Governance SETS the caps;
 * Monitoring watches live spend. A cap is a policy action: per key / domain /
 * tenant, including the STACKIT premium-model cap and per-agent budgets. The
 * enforcement seam is `checkCap`: any metered action asks here before running,
 * and an over-cap action is BLOCKED. Authoritative in-process store; a real
 * deploy reconciles these into LiteLLM budgets (the live adapter), but the
 * decision logic is the same here so it works offline.
 */

export type CapScope = 'key' | 'domain' | 'tenant';

export type Cap = {
  id: string;
  scope: CapScope;
  /** The thing capped: a LiteLLM key, a domain name, or "tenant". */
  subject: string;
  /** Spend ceiling in the period, in currency units (e.g. EUR). */
  limit: number;
  period: 'day' | 'month';
  /** Optional model class this cap applies to (e.g. "premium"). */
  modelClass?: string;
  createdBy: string;
  createdAt: string;
};

type CostState = { caps: Map<string, Cap>; spend: Map<string, number> };
const COST_KEY = Symbol.for('soa.governance.cost');
function costState(): CostState {
  const g = globalThis as unknown as Record<symbol, CostState | undefined>;
  if (!g[COST_KEY]) g[COST_KEY] = { caps: new Map(), spend: new Map() };
  return g[COST_KEY]!;
}

function key(scope: CapScope, subject: string, modelClass?: string): string {
  return `${scope}:${subject}:${modelClass ?? '*'}`;
}

export function setCap(input: {
  scope: CapScope;
  subject: string;
  limit: number;
  period?: 'day' | 'month';
  modelClass?: string;
  createdBy: string;
}): Cap {
  const k = key(input.scope, input.subject, input.modelClass);
  const cap: Cap = {
    id: k,
    scope: input.scope,
    subject: input.subject,
    limit: input.limit,
    period: input.period ?? 'month',
    modelClass: input.modelClass,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  costState().caps.set(k, cap);
  return cap;
}

export function listCaps(domains?: string[]): Cap[] {
  return [...costState().caps.values()]
    .filter((c) =>
      domains ? c.scope === 'tenant' || (c.scope === 'domain' && domains.includes(c.subject)) || c.scope === 'key' : true,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Record spend against a subject (test/demo helper; live = LiteLLM usage). */
export function addSpend(scope: CapScope, subject: string, amount: number, modelClass?: string): void {
  const k = key(scope, subject, modelClass);
  costState().spend.set(k, (costState().spend.get(k) ?? 0) + amount);
}

/** Read current accumulated spend for a subject (read-only; seed via addSpend in tests). */
export function getSpend(scope: CapScope, subject: string, modelClass?: string): number {
  const k = key(scope, subject, modelClass);
  return costState().spend.get(k) ?? costState().spend.get(key(scope, subject)) ?? 0;
}

/**
 * Reconcile the in-process spend Map with LIVE LiteLLM spend so `getSpend` (and the
 * alerts/home consumers that read it) reflect REAL usage, not only the test-seeded
 * Map. LiteLLM groups spend by tag subject (per-user / per-domain / bare) — we map
 * each subject onto the matching cap scope so a domain cap sees its domain's spend.
 *
 * HONEST: this never fabricates. When LiteLLM is unreachable the Map is left as-is;
 * when it reports $0 (self-hosted models cost nothing per token) that real 0 flows
 * through. Sync `getSpend`/`checkCap` are unchanged — this is an async pre-step the
 * overview builder runs so the numbers the user sees are live. Imported lazily to
 * avoid a cycle with the monitoring adapter (which imports `listCaps` from here).
 */
export async function reconcileSpendFromLiteLLM(): Promise<void> {
  const { litellmSpendByTag } = await import('@/lib/monitoring/adapters/cost');
  const byTag = await litellmSpendByTag();
  if (!byTag) return; // unreachable → leave the Map untouched (don't zero real seeds)
  const st = costState();
  // Map each known cap's subject to its live spend. A domain/tenant/key cap's
  // subject is matched against the LiteLLM tag subjects (domain name or user id).
  for (const cap of st.caps.values()) {
    const live = byTag[cap.subject];
    if (live !== undefined) st.spend.set(key(cap.scope, cap.subject), live);
  }
  // Also surface any live subject that has no cap yet (so getSpend is truthful for
  // a domain the admin hasn't capped). Recorded as a domain-scoped spend entry.
  for (const [subject, spent] of Object.entries(byTag)) {
    const dk = key('domain', subject);
    if (!st.spend.has(dk)) st.spend.set(dk, spent);
  }
}

export type CapCheck = { allowed: boolean; reason: string; cap?: Cap; projected: number };

/**
 * The enforcement point: would `amount` more spend breach a cap on `subject`?
 * Checks the most specific cap (key → domain → tenant). No cap → allowed.
 */
export function checkCap(input: {
  scope: CapScope;
  subject: string;
  amount: number;
  modelClass?: string;
}): CapCheck {
  const k = key(input.scope, input.subject, input.modelClass);
  const cap = costState().caps.get(k) ?? costState().caps.get(key(input.scope, input.subject));
  if (!cap) return { allowed: true, reason: 'no cap set', projected: input.amount };
  const current = costState().spend.get(k) ?? costState().spend.get(key(input.scope, input.subject)) ?? 0;
  const projected = current + input.amount;
  if (projected > cap.limit) {
    return {
      allowed: false,
      reason: `over cap: ${projected} > ${cap.limit} ${cap.period}${cap.modelClass ? ` (${cap.modelClass})` : ''}`,
      cap,
      projected,
    };
  }
  return { allowed: true, reason: `within cap (${projected}/${cap.limit})`, cap, projected };
}

export function __resetCost(): void {
  costState().caps.clear();
  costState().spend.clear();
}
