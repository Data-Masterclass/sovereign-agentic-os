/**
 * FEATURE:    Tests of the classify_order rule and its agent-function route.
 * USER STORY: As a finance lead I want proof that the review limit is applied the same way every time.
 * ARCHITECTURE: Pure rule tests plus the route handler called with a Web Request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOrder, REVIEW_LIMIT } from '../src/lib/classify-order.ts';
import { POST } from '../src/app/api/functions/classify-order/route.ts';

test('an amount at the limit is standard, above it needs review', () => {
  assert.equal(classifyOrder(REVIEW_LIMIT).tier, 'standard');
  assert.equal(classifyOrder(REVIEW_LIMIT + 1).tier, 'review');
});

test('a negative or non-finite amount is refused', () => {
  assert.throws(() => classifyOrder(-1), RangeError);
  assert.throws(() => classifyOrder(Number.NaN), RangeError);
});

test('the route classifies a valid body', async () => {
  const res = await POST(new Request('http://app/x', { method: 'POST', body: JSON.stringify({ amount: 25_000 }) }));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { tier: string }).tier, 'review');
});

test('the route answers 400 with a reason for a bad body', async () => {
  for (const body of ['not json', JSON.stringify({ amount: 'x' }), JSON.stringify({ amount: -5 })]) {
    const res = await POST(new Request('http://app/x', { method: 'POST', body }));
    assert.equal(res.status, 400);
  }
});
