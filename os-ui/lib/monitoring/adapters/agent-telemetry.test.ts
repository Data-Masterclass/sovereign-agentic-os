/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tests for the Langfuse→RawRun mapping in the agent-telemetry batch:
 *   • tokens falls back to our own `metadata.tokens` (the run-summary trace)
 *     when Langfuse has no rolled-up totalTokens/usage;
 *   • cost precedence puts `metadata.costUsd` FIRST — Langfuse reports
 *     totalCost 0 (not absent) for unpriced generations, which used to
 *     short-circuit the `??` chain and pin cost to $0.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { agentTelemetryBatch } from './agent-telemetry.ts';

const realFetch = globalThis.fetch;

/** Stub globalThis.fetch to return the given Langfuse /api/public/traces rows. */
function stubLangfuse(rows: unknown[]): void {
  globalThis.fetch = (async () =>
    ({ ok: true, text: async () => JSON.stringify({ data: rows }) }) as unknown as Response) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = (async () => null) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('batch maps metadata.tokens + prefers metadata.costUsd over a Langfuse totalCost of 0', async () => {
  const nowMs = Date.now();
  const at = new Date(nowMs - 60_000).toISOString();
  stubLangfuse([
    {
      id: 'lf-1',
      timestamp: at,
      name: 'agent.generate',
      totalCost: 0, // Langfuse's "unpriced" 0 must NOT beat our explicit cost
      metadata: { principal: 'os-sys_1:run', decision: 'allow', costUsd: 0.25, tokens: 1234 },
    },
  ]);

  const { runsBySystem, langfuseReachable } = await agentTelemetryBatch(nowMs);
  assert.equal(langfuseReachable, true);
  const runs = runsBySystem.get('sys_1');
  assert.ok(runs && runs.length === 1, 'run attributed to sys_1 via the os- principal');
  assert.equal(runs![0].tokens, 1234, 'tokens read from metadata.tokens');
  assert.equal(runs![0].costUsd, 0.25, 'metadata.costUsd wins over totalCost 0');
});

test('batch still prefers Langfuse rolled-up totals when present', async () => {
  const nowMs = Date.now();
  const at = new Date(nowMs - 60_000).toISOString();
  stubLangfuse([
    {
      id: 'lf-2',
      timestamp: at,
      name: 'agent.generate',
      totalCost: 0.5,
      totalTokens: 999,
      metadata: { principal: 'os-sys_2:run', decision: 'allow', tokens: 1 },
    },
  ]);

  const { runsBySystem } = await agentTelemetryBatch(nowMs);
  const runs = runsBySystem.get('sys_2');
  assert.ok(runs && runs.length === 1);
  assert.equal(runs![0].tokens, 999, 'Langfuse totalTokens beats metadata.tokens');
  assert.equal(runs![0].costUsd, 0.5, 'a real Langfuse totalCost is used when we set no costUsd');
});
