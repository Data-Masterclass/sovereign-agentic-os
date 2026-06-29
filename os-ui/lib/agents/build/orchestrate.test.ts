/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrateBuild } from './orchestrate.ts';
import { newMockBackends, makeMockAdapters } from './mocks.ts';

const SUP = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: supervisor
grants:
  tools: [metrics, retrieve]
  connections:
    - { id: crm, capability: Read }
agents:
  - id: supervisor
    role: router
    agent_md: "# Supervisor\\nRoute work."
    memory_md: "# Mem"
    members: [worker]
    tools: [metrics]
  - id: worker
    role: specialist
    agent_md: "# Worker"
    memory_md: ""
    tools: [retrieve]
    model: ministral-3
edges:
  - { from: supervisor, to: worker, type: supervise }
`;

test('a valid system builds all-green across the 5 adapters', async () => {
  const backends = newMockBackends();
  const report = await orchestrateBuild({
    yaml: SUP,
    systemId: 'sys_test',
    adapters: makeMockAdapters(backends),
  });
  assert.equal(report.ok, true, JSON.stringify(report.rows, null, 2));
  assert.deepEqual(
    report.rows.map((r) => r.tool).sort(),
    ['forgejo', 'langfuse', 'langgraph', 'litellm', 'opa'],
  );
  for (const r of report.rows) assert.equal(r.status, 'ok', `${r.tool}: ${r.error ?? ''}`);

  // The files really landed in the (mock) Forgejo repo.
  assert.ok(backends.forgejo.files.has('system.yaml'));
  assert.ok(backends.forgejo.files.has('agents/worker/AGENT.md'));
  // The test invocation produced Langfuse traces (what the langfuse row verifies).
  assert.ok(backends.langfuse.traces.length > 0);
});

test('broken yaml surfaces a ✗ langgraph row carrying the compiler error', async () => {
  const broken = `
entrypoint: supervisor
grants: { tools: [retrieve] }
agents:
  - { id: supervisor, role: r, agent_md: "", memory_md: "", tools: [retrieve, connection_crm_write] }
`;
  const backends = newMockBackends();
  const report = await orchestrateBuild({ yaml: broken, adapters: makeMockAdapters(backends) });
  assert.equal(report.ok, false);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].tool, 'langgraph');
  assert.equal(report.rows[0].status, 'fail');
  assert.match(report.rows[0].error ?? '', /not granted to the system \(narrow-only\)/);
});

test('the OPA row proves a granted tool resolves and a non-granted one is blocked', async () => {
  const backends = newMockBackends();
  const report = await orchestrateBuild({ yaml: SUP, adapters: makeMockAdapters(backends) });
  const opa = report.rows.find((r) => r.tool === 'opa')!;
  assert.equal(opa.status, 'ok');
  assert.match(opa.detail, /granted/);
  assert.match(opa.detail, /blocked|denied/);
});

test('the LiteLLM row proves light→Ministral and reasoning→local Magistral routing', async () => {
  const backends = newMockBackends();
  const report = await orchestrateBuild({ yaml: SUP, adapters: makeMockAdapters(backends) });
  const litellm = report.rows.find((r) => r.tool === 'litellm')!;
  assert.equal(litellm.status, 'ok');
  assert.match(litellm.detail.toLowerCase(), /ministral/);
  assert.match(litellm.detail.toLowerCase(), /sovereign-reasoning/);
});
