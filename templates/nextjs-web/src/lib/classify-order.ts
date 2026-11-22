/**
 * FEATURE:    The business rule behind the `classify_order` agent function.
 * USER STORY: As a finance lead I want orders above the review limit flagged, the same way for
 *             people and for agents.
 * ARCHITECTURE: Pure function, no I/O, so it is unit-tested alone. The route in
 *               src/app/api/functions/classify-order wraps it; actions.yml declares it to the OS.
 */
export const REVIEW_LIMIT = 10_000;

export type Classification = { tier: 'standard' | 'review'; reason: string };

export function classifyOrder(amount: number, limit: number = REVIEW_LIMIT): Classification {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError('amount must be a non-negative number');
  return amount > limit
    ? { tier: 'review', reason: `amount ${amount} is above the review limit ${limit}` }
    : { tier: 'standard', reason: `amount ${amount} is within the review limit ${limit}` };
}
