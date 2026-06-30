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

const caps = new Map<string, Cap>();
/** Best-effort running spend, so over-cap can be demonstrated offline. */
const spend = new Map<string, number>();

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
  caps.set(k, cap);
  return cap;
}

export function listCaps(domains?: string[]): Cap[] {
  return [...caps.values()]
    .filter((c) =>
      domains ? c.scope === 'tenant' || (c.scope === 'domain' && domains.includes(c.subject)) || c.scope === 'key' : true,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Record spend against a subject (test/demo helper; live = LiteLLM usage). */
export function addSpend(scope: CapScope, subject: string, amount: number, modelClass?: string): void {
  const k = key(scope, subject, modelClass);
  spend.set(k, (spend.get(k) ?? 0) + amount);
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
  const cap = caps.get(k) ?? caps.get(key(input.scope, input.subject));
  if (!cap) return { allowed: true, reason: 'no cap set', projected: input.amount };
  const current = spend.get(k) ?? spend.get(key(input.scope, input.subject)) ?? 0;
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
  caps.clear();
  spend.clear();
}
