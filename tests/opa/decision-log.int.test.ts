/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * decision-log.int.test — against the REAL OPA container started from the chart
 * (tests/opa/run-chart-opa.py, CI job `test-opa`).
 *
 * Asserts (04 §7.1): each os-ui decision gives exactly one console decision-log line
 * carrying the `decision_id` os-ui got back, with the policy revision label, and masked
 * fields are absent. The negative twin proves the evidence check cannot be satisfied
 * by a faked OPA hop.
 *
 * Run: OPA_IT_URL=http://127.0.0.1:18181 OPA_IT_CONTAINER=opa-it \
 *   node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/decision-log.int.test.ts
 * (from os-ui/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const OPA = process.env.OPA_IT_URL;
const CONTAINER = process.env.OPA_IT_CONTAINER;
if (!OPA || !CONTAINER) {
  throw new Error('decision-log.int.test needs OPA_IT_URL and OPA_IT_CONTAINER (a real OPA container)');
}
process.env.OPA_URL = OPA;

type LogLine = Record<string, unknown> & {
  decision_id?: string;
  path?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  labels?: Record<string, string>;
  erased?: string[];
};

function rawLogs(): string {
  // The console decision logger writes through OPA's logger (the container's stderr);
  // read both streams so nothing is missed.
  const r = spawnSync('docker', ['logs', CONTAINER!], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker logs ${CONTAINER} failed: ${r.stderr}`);
  return `${r.stdout}\n${r.stderr}`;
}

function decisionLines(): LogLine[] {
  const out: LogLine[] = [];
  for (const l of rawLogs().split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      const j = JSON.parse(l) as LogLine;
      if (j.msg === 'Decision Log') out.push(j);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

async function linesFor(id: string, waitMs = 5000): Promise<LogLine[]> {
  const until = Date.now() + waitMs;
  for (;;) {
    const hits = decisionLines().filter((l) => l.decision_id === id);
    if (hits.length > 0 || Date.now() > until) return hits;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('governed authorize() returns the decision_id, and OPA logs exactly one decision line for it', async () => {
  const { authorize } = await import('@core/infra/governed');
  // `sovereign-agents` → `rag_search` is a chart default grant (values.yaml opa.grants).
  const a = await authorize('sovereign-agents', 'rag_search');
  assert.equal(a.policy, 'opa-allow');
  assert.match(a.decisionId ?? '', /^[0-9a-f-]{36}$/, 'OPA returns a decision_id when decision logging is on');
  const hits = await linesFor(a.decisionId!);
  assert.equal(hits.length, 1, 'exactly one decision-log line per decision');
  const line = hits[0];
  assert.equal(line.path, 'agentic/authz/allow');
  assert.equal(line.result, true);
  assert.deepEqual(line.input, { principal: 'sovereign-agents', tool: 'rag_search' });
  assert.ok(a.policyRev, 'os-ui reads the policy revision from OPA');
  assert.equal(line.labels?.policy_rev, a.policyRev, 'the log line and os-ui agree on the policy revision');
});

test('agent-spine authorize() carries the decision_id of a deny', async () => {
  const { authorize } = await import('@core/infra/agent-governed');
  const a = await authorize('nobody-wp06', 'web_fetch' as never);
  assert.equal(a.effect, 'deny');
  assert.equal(a.policy, 'opa-deny');
  assert.match(a.decisionId ?? '', /^[0-9a-f-]{36}$/);
  const [line] = await linesFor(a.decisionId!);
  assert.ok(line, 'the deny is in the decision log');
  assert.equal(line.path, 'agentic/authz/decision');
  assert.equal((line.result as { effect?: string }).effect, 'deny');
});

test('masked input fields never reach the decision log', async () => {
  const secret = `wp06-secret-${Date.now()}`;
  const res = await fetch(`${OPA}/v1/data/agentic/authz/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { principal: 'sovereign-agents', tool: 'rag_search', token: secret } }),
  });
  const body = (await res.json()) as { decision_id?: string };
  assert.ok(body.decision_id);
  const [line] = await linesFor(body.decision_id!);
  assert.ok(line, 'the decision was logged');
  assert.equal(line.input?.principal, 'sovereign-agents', 'unmasked fields stay');
  assert.equal('token' in (line.input ?? {}), false, 'masked field removed');
  assert.ok(line.erased?.includes('/input/token'), 'OPA records what it erased');
  assert.equal(rawLogs().includes(secret), false, 'the secret appears nowhere in the OPA output');
});

test('negative twin: a faked OPA hop leaves no decision-log evidence', async () => {
  const fakeId = '00000000-0000-4000-8000-000000000000';
  const fake = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: true, decision_id: fakeId }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  try {
    const port = (fake.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/data/agentic/authz/allow`, { method: 'POST', body: '{}' });
    const body = (await res.json()) as { decision_id: string };
    assert.equal(body.decision_id, fakeId);
    // The evidence check used above must NOT pass for an id the real OPA never decided.
    assert.deepEqual(await linesFor(body.decision_id, 1500), []);
  } finally {
    fake.close();
  }
});
