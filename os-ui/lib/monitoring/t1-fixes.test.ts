/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Integration tests for the three T1 monitoring bug-fixes.
 *
 *   Bug 2 — collectCost: caps must come from the governance cost store, not
 *            hardcoded values. Real caps → source:'live'; no caps → mock fallback.
 *
 *   Bug 3 — collectSystem: the always-injected fake "dagster-ingest OOMKilled"
 *            item (sys-4001) must never appear when k8s is unreachable.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setCap, __resetCost } from '@/lib/governance';
import { collectCost } from '@/lib/monitoring/adapters/cost.ts';
import { collectSystem } from '@/lib/monitoring/adapters/system-health.ts';

const realFetch = globalThis.fetch;

/** Stub globalThis.fetch to return the given LiteLLM /spend/tags rows once. */
function stubLitellmTags(rows: unknown[]): void {
  globalThis.fetch = (async () =>
    ({ ok: true, text: async () => JSON.stringify(rows) }) as unknown as Response) as unknown as typeof fetch;
}

beforeEach(() => {
  __resetCost();
  // Stub all HTTP offline so LiteLLM spend calls return null fast.
  globalThis.fetch = (async () => null) as unknown as typeof fetch;
});

afterEach(() => {
  __resetCost();
  globalThis.fetch = realFetch;
});

// ── Bug 2: caps from governance store ─────────────────────────────────────────

test('Bug-2: collectCost falls back to mock when governance store has no caps', async () => {
  const items = await collectCost();
  assert.ok(items.length > 0, 'Expected mock items as fallback');
  assert.ok(items.every((i) => i.source === 'mock'),
    'All items must be source:mock when no governance caps are set');
});

test('Bug-2: collectCost uses governance cap, not hardcoded caps', async () => {
  // Seed an "hr" domain cap — a domain that was NEVER in the old hardcoded list.
  setCap({ scope: 'domain', subject: 'hr', limit: 150, period: 'month', createdBy: 'a_root' });

  const items = await collectCost();
  const hrItem = items.find((i) => i.domain === 'hr');
  assert.ok(hrItem, 'Expected an item for the governance-set hr domain');
  assert.equal(hrItem!.cap?.limitUsd, 150, 'Cap limit must match the governance store value');
  assert.equal(hrItem!.source, 'live', 'Real cap → source must be live');

  // The old hardcoded sales/finance caps must NOT appear (no one set them in governance).
  assert.ok(!items.find((i) => i.domain === 'sales'), 'Hardcoded sales cap must not appear');
  assert.ok(!items.find((i) => i.domain === 'finance'), 'Hardcoded finance cap must not appear');
});

test('Bug-2: collectCost with real cap and no LiteLLM returns spend=0 (not mock)', async () => {
  setCap({ scope: 'domain', subject: 'sales', limit: 200, period: 'month', createdBy: 'a_root' });

  const items = await collectCost();
  const salesItem = items.find((i) => i.domain === 'sales');
  assert.ok(salesItem, 'Expected a sales item from the real governance cap');
  assert.equal(salesItem!.metric, 0, 'Spend should be 0 when LiteLLM is offline');
  assert.equal(salesItem!.source, 'live', 'Source must be live even when spend is 0');
  assert.equal(salesItem!.cap?.limitUsd, 200, 'Cap limit must match governance store');
});

// ── Gap 1: live LiteLLM spend flows even without a cap ────────────────────────

test('Cost: live LiteLLM per-tag spend surfaces (no cap) instead of mock', async () => {
  // Real LiteLLM /spend/tags shape: individual_request_tag + total_spend. Mix of
  // user:/User-Agent:/bare tags — the parser strips user:, DROPS User-Agent:, keeps bare.
  stubLitellmTags([
    { individual_request_tag: 'user:ab@borekdata.com', log_count: 1, total_spend: 0.42 },
    { individual_request_tag: 'User-Agent: node', log_count: 1303, total_spend: 0.0 },
    { individual_request_tag: 'assistant', log_count: 1, total_spend: 0.0 },
  ]);

  const items = await collectCost();
  assert.ok(items.every((i) => i.source === 'live'), 'Live gateway → no mock items');
  assert.ok(items.find((i) => i.domain === 'ab@borekdata.com'), 'user: prefix stripped, subject kept');
  assert.ok(items.find((i) => i.domain === 'assistant'), 'bare tag kept as-is');
  assert.ok(!items.find((i) => /user-agent/i.test(i.domain)), 'User-Agent: transport tags dropped');
});

test('Cost: $0 live spend is honest live data, NOT a fall to mock', async () => {
  // Self-hosted models cost nothing per token — a reachable gateway reporting all
  // zeros must still be source:live, never the offline mock.
  stubLitellmTags([{ individual_request_tag: 'user:sales@x.com', log_count: 5, total_spend: 0.0 }]);
  const items = await collectCost();
  assert.ok(items.length > 0 && items.every((i) => i.source === 'live'), 'zero spend still live');
  assert.equal(items.find((i) => i.domain === 'sales@x.com')?.metric, 0, 'honest $0');
});

test('Cost: cap measured against live per-domain spend', async () => {
  setCap({ scope: 'domain', subject: 'sales', limit: 200, period: 'month', createdBy: 'a_root' });
  stubLitellmTags([{ individual_request_tag: 'sales', log_count: 10, total_spend: 190 }]);
  const items = await collectCost();
  const sales = items.find((i) => i.domain === 'sales');
  assert.equal(sales?.metric, 190, 'live spend measured against the cap');
  assert.equal(sales?.health, 'amber', '190/200 = 95% → amber');
  assert.equal(sales?.source, 'live');
});

// ── Bug 3: no fake OOM injected ───────────────────────────────────────────────

test('Bug-3: collectSystem does not inject fake OOMKilled item when k8s is unreachable', async () => {
  const items = await collectSystem();
  const oomItem = items.find((i) => i.id === 'sys-4001');
  assert.ok(!oomItem,
    'sys-4001 (fake dagster-ingest OOMKilled) must never appear — it was always-injected mock data');
});

test('Bug-3: collectSystem returns only live items (never source:mock)', async () => {
  const items = await collectSystem();
  assert.ok(items.every((i) => i.source === 'live'),
    'All system-health items must be source:live; mock items must not be present');
});

test('Bug-3: collectSystem returns empty array when cluster is unreachable (honest)', async () => {
  // k8s() degrades to { status: 0, body: {} } outside a cluster, statusOf returns
  // 'unknown', all workloads are filtered out → collectSystem must return [].
  const items = await collectSystem();
  assert.equal(items.length, 0,
    'No cluster → empty array is the honest "health unavailable" response');
});
