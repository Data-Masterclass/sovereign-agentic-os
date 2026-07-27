/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestMetricsMessages,
  parseCandidates,
  groundingOf,
  SuggestError,
  type SuggestContext,
} from './suggest.ts';

const CTX: SuggestContext = {
  goal: 'grow revenue',
  pillars: [
    { id: 'pil_growth', name: 'Growth', description: 'grow net revenue' },
    { id: 'pil_ret', name: 'Retention', description: 'keep customers' },
  ],
  omSections: [{ id: 'strategy', title: 'Strategy', content: 'win on price' }],
  workflows: [
    {
      id: 'wf_checkout',
      title: 'Checkout',
      steps: [{ title: 'Pay', actor: 'Customer' }],
      hardRules: ['never store raw card numbers'],
      actors: ['Customer'],
    },
  ],
  datasets: [
    {
      id: 'ds_orders',
      name: 'Orders',
      tier: 'asset',
      description: 'one row per order',
      columns: [{ name: 'net_amount' }, { name: 'region' }, { name: 'order_date' }],
      measures: [{ name: 'orders', type: 'count' }],
      deliverable: true,
    },
    {
      id: 'ds_customers',
      name: 'Customers',
      tier: 'asset',
      description: 'one row per customer',
      columns: [{ name: 'customer_id' }, { name: 'signup_date' }],
      measures: [],
      deliverable: false,
    },
  ],
};

test('suggestMetricsMessages grounds the prompt in the real context', () => {
  const msgs = suggestMetricsMessages(CTX);
  assert.equal(msgs[0].role, 'system');
  // datasets, columns, pillars, workflow hard rules all appear in the user prompt
  assert.match(msgs[1].content, /ds_orders/);
  assert.match(msgs[1].content, /net_amount/);
  assert.match(msgs[1].content, /pil_growth/);
  assert.match(msgs[1].content, /wf_checkout/);
  assert.match(msgs[1].content, /never store raw card numbers/);
  assert.match(msgs[1].content, /grow revenue/);
});

test('parseCandidates keeps a valid candidate and grounds its pillar/process', () => {
  const raw = JSON.stringify({
    candidates: [
      {
        name: 'Revenue',
        description: 'total net revenue',
        why: 'serves Growth',
        pillarId: 'pil_growth',
        processId: 'wf_checkout',
        datasetId: 'ds_orders',
        form: { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: ['region'] },
      },
    ],
  });
  const { candidates, grounding } = parseCandidates(raw, CTX);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.datasetId, 'ds_orders');
  assert.equal(c.form.aggregation, 'sum');
  assert.equal(c.form.column, 'net_amount');
  assert.deepEqual(c.form.dimensions, ['region']);
  assert.equal(c.pillarId, 'pil_growth');
  assert.equal(c.processId, 'wf_checkout');
  assert.deepEqual(grounding, { pillars: 2, omSections: 1, workflows: 1, datasets: 2 });
});

test('parseCandidates drops a candidate on an INVISIBLE dataset (never fabricates access)', () => {
  const raw = JSON.stringify({
    candidates: [
      { name: 'Ghost', datasetId: 'ds_missing', form: { name: 'Ghost', aggregation: 'count', column: '', dimensions: [] } },
      { name: 'Revenue', datasetId: 'ds_orders', form: { name: 'Revenue', aggregation: 'sum', column: 'net_amount', dimensions: [] } },
    ],
  });
  const { candidates } = parseCandidates(raw, CTX);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'Revenue');
});

test('parseCandidates drops a fabricated column and clears an invented pillar/process', () => {
  const raw = JSON.stringify({
    candidates: [
      // fabricated base column → dropped entirely (a sum needs a real column)
      { name: 'Bad', datasetId: 'ds_orders', form: { name: 'Bad', aggregation: 'sum', column: 'not_a_col', dimensions: [] } },
      // invented pillar/process ids → cleared; ghost dimension → filtered out
      {
        name: 'Orders',
        datasetId: 'ds_orders',
        pillarId: 'pil_nope',
        processId: 'wf_nope',
        form: { name: 'Orders', aggregation: 'count', column: '', dimensions: ['region', 'ghost'] },
      },
    ],
  });
  const { candidates } = parseCandidates(raw, CTX);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.name, 'Orders');
  assert.equal(c.form.column, ''); // count → no column
  assert.deepEqual(c.form.dimensions, ['region']); // "ghost" dropped
  assert.equal(c.pillarId, undefined); // invented → cleared
  assert.equal(c.processId, undefined);
});

test('parseCandidates keeps crossEntity only for datasets the caller can see', () => {
  const raw = JSON.stringify({
    candidates: [
      {
        name: 'Revenue per customer',
        datasetId: 'ds_orders',
        form: { name: 'Revenue per customer', aggregation: 'sum', column: 'net_amount', dimensions: [] },
        crossEntity: { note: 'needs customer signup', datasets: ['ds_customers', 'ds_missing'] },
      },
    ],
  });
  const { candidates } = parseCandidates(raw, CTX);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].crossEntity, { note: 'needs customer signup', datasets: ['ds_customers'] });
});

test('parseCandidates tolerates ```json fences', () => {
  const raw = '```json\n{"candidates":[{"name":"Orders","datasetId":"ds_orders","form":{"name":"Orders","aggregation":"count","column":"","dimensions":[]}}]}\n```';
  const { candidates } = parseCandidates(raw, CTX);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'Orders');
});

test('parseCandidates rejects unparseable output (honest error, never fabricated)', () => {
  assert.throws(() => parseCandidates('the model rambled with no json', CTX), (e: unknown) => e instanceof SuggestError);
});

test('parseCandidates returns an empty list (not an error) when the model proposes nothing', () => {
  const { candidates, grounding } = parseCandidates(JSON.stringify({ candidates: [] }), CTX);
  assert.deepEqual(candidates, []);
  assert.deepEqual(grounding, groundingOf(CTX));
});
