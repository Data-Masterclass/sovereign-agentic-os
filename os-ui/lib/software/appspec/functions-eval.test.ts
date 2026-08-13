/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * functions-eval.test — the RUNTIME resolver. With a STUBBED `os` client (counting queries), pins:
 * every aggregate op (count/sum/avg/min/max) + filters reduces the governed grid correctly;
 * expressions fold over resolved fn refs; a reference CYCLE resolves to null (never loops); each
 * distinct dataset is queried ONCE (memoization) even across several aggregates; and a failed query
 * → null (honest, not a throw).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import { evaluateFunctions } from './functions-eval.ts';
import type { AppFunction } from './functions-schema.ts';

/** A stub os whose `datasets.query` returns pre-seeded grids and counts calls per dataset id. */
function stubOs(grids: Record<string, QueryResult>, opts?: { fail?: Set<string> }): { os: OsClient; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const os = {
    datasets: {
      async query(id: string): Promise<QueryResult> {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        if (opts?.fail?.has(id)) throw new Error('forbidden');
        return grids[id] ?? { columns: [], rows: [], rowCount: 0 };
      },
    },
  } as unknown as OsClient;
  return { os, calls };
}

function grid(columns: string[], rows: string[][]): QueryResult {
  return { columns, rows, rowCount: rows.length };
}

const ORDERS = grid(
  ['status', 'amount', 'region'],
  [
    ['open', '100', 'eu'],
    ['open', '50', 'us'],
    ['closed', '200', 'eu'],
    ['open', '', 'eu'], // blank amount ignored by numeric ops
  ],
);

function agg(id: string, op: 'count' | 'sum' | 'avg' | 'min' | 'max', extra: Partial<AppFunction> = {}): AppFunction {
  return { id, name: id, description: id, kind: 'aggregate', source: { datasetId: 'orders' }, op, ...(extra as object) } as AppFunction;
}
function expr(id: string, e: string): AppFunction {
  return { id, name: id, description: id, kind: 'expression', expr: e };
}

test('aggregate count / sum / avg / min / max over the governed grid', async () => {
  const { os } = stubOs({ orders: ORDERS });
  const fns: AppFunction[] = [
    agg('c', 'count'),
    agg('s', 'sum', { field: 'amount' }),
    agg('a', 'avg', { field: 'amount' }),
    agg('mn', 'min', { field: 'amount' }),
    agg('mx', 'max', { field: 'amount' }),
  ];
  const v = await evaluateFunctions(fns, os);
  assert.equal(v.c, 4); // 4 rows
  assert.equal(v.s, 350); // 100 + 50 + 200 (blank ignored)
  assert.equal(v.a, 350 / 3); // over 3 numeric cells, not 4
  assert.equal(v.mn, 50);
  assert.equal(v.mx, 200);
});

test('aggregate filters (eq / gt) reduce only matching rows', async () => {
  const { os } = stubOs({ orders: ORDERS });
  const fns: AppFunction[] = [
    agg('openCount', 'count', { filters: [{ field: 'status', op: 'eq', value: 'open' }] }),
    agg('bigSum', 'sum', { field: 'amount', filters: [{ field: 'amount', op: 'gt', value: 60 }] }),
    agg('euOpen', 'count', {
      filters: [
        { field: 'status', op: 'eq', value: 'open' },
        { field: 'region', op: 'eq', value: 'eu' },
      ],
    }),
  ];
  const v = await evaluateFunctions(fns, os);
  assert.equal(v.openCount, 3); // 3 rows are open
  assert.equal(v.bigSum, 300); // 100 + 200 (>60)
  assert.equal(v.euOpen, 2); // open+eu rows
});

test('sum/avg/min/max return null when no numeric cell survives the reduce', async () => {
  const { os } = stubOs({ orders: ORDERS });
  const fns: AppFunction[] = [
    agg('noneSum', 'sum', { field: 'amount', filters: [{ field: 'status', op: 'eq', value: 'never' }] }),
  ];
  const v = await evaluateFunctions(fns, os);
  assert.equal(v.noneSum, null);
});

test('expression folds over resolved aggregate refs', async () => {
  const { os } = stubOs({ orders: ORDERS });
  const fns: AppFunction[] = [
    agg('total', 'count'),
    agg('open', 'count', { filters: [{ field: 'status', op: 'eq', value: 'open' }] }),
    expr('openRate', 'fn.open / fn.total'),
    expr('mostlyOpen', 'fn.open / fn.total > 0.5'),
  ];
  const v = await evaluateFunctions(fns, os);
  assert.equal(v.openRate, 3 / 4);
  assert.equal(v.mostlyOpen, true);
});

test('expression chains resolve in DAG order regardless of declaration order', async () => {
  const { os } = stubOs({ orders: ORDERS });
  const fns: AppFunction[] = [
    expr('c', 'fn.b + 1'), // depends on b, declared first
    expr('b', 'fn.a * 2'), // depends on a
    agg('a', 'count'), // leaf
  ];
  const v = await evaluateFunctions(fns, os);
  assert.equal(v.a, 4);
  assert.equal(v.b, 8);
  assert.equal(v.c, 9);
});

test('a reference CYCLE resolves to null (and does not loop forever)', async () => {
  const { os } = stubOs({ orders: ORDERS });
  const fns: AppFunction[] = [
    expr('x', 'fn.y + 1'),
    expr('y', 'fn.x + 1'), // x ↔ y cycle
    agg('safe', 'count'),
  ];
  const v = await evaluateFunctions(fns, os);
  assert.equal(v.x, null);
  assert.equal(v.y, null);
  assert.equal(v.safe, 4); // unrelated functions still resolve
});

test('a self-reference resolves to null', async () => {
  const { os } = stubOs({ orders: ORDERS });
  const v = await evaluateFunctions([expr('me', 'fn.me + 1')], os);
  assert.equal(v.me, null);
});

test('memoization: each distinct dataset is queried ONCE across many aggregates', async () => {
  const { os, calls } = stubOs({ orders: ORDERS, other: grid(['n'], [['1'], ['2']]) });
  const fns: AppFunction[] = [
    agg('c1', 'count'),
    agg('c2', 'sum', { field: 'amount' }),
    agg('c3', 'count', { filters: [{ field: 'status', op: 'eq', value: 'open' }] }),
    { id: 'o1', name: 'o1', description: 'o1', kind: 'aggregate', source: { datasetId: 'other' }, op: 'count' },
  ];
  await evaluateFunctions(fns, os);
  assert.equal(calls.get('orders'), 1); // three aggregates share ONE query
  assert.equal(calls.get('other'), 1);
});

test('a failed/forbidden query → null (honest), not a throw', async () => {
  const { os } = stubOs({ orders: ORDERS }, { fail: new Set(['orders']) });
  const fns: AppFunction[] = [agg('c', 'count'), expr('d', 'fn.c + 1')];
  const v = await evaluateFunctions(fns, os);
  assert.equal(v.c, null);
  assert.equal(v.d, null); // expression over a null aggregate is null
});
