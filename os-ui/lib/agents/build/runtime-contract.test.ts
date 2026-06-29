/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem } from '../system-schema.ts';
import { compile } from '../langgraph-compile.ts';
import {
  RUNTIME_DEFAULTS,
  principalFor,
  reloadRequest,
  runRequest,
} from './runtime-contract.ts';

const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: supervisor
grants: { tools: [retrieve] }
agents:
  - { id: supervisor, role: r, agent_md: "# s", memory_md: "", members: [worker] }
  - { id: worker, role: w, agent_md: "# w", memory_md: "", tools: [retrieve] }
edges:
  - { from: supervisor, to: worker, type: supervise }
`;

test('reloadRequest carries the compiled IR keyed by systemId', () => {
  const ir = compile(parseSystem(YAML));
  const req = reloadRequest('sys_1', ir);
  assert.equal(req.systemId, 'sys_1');
  assert.equal(req.ir.entrypoint, 'supervisor');
  assert.equal(req.ir.nodes.length, 2);
});

test('runRequest applies the recursion + timeout guards as defaults', () => {
  const req = runRequest('sys_1', 'hello');
  assert.equal(req.systemId, 'sys_1');
  assert.equal(req.prompt, 'hello');
  assert.equal(req.recursionLimit, RUNTIME_DEFAULTS.recursionLimit);
  assert.equal(req.timeoutMs, RUNTIME_DEFAULTS.timeoutMs);
  assert.deepEqual(req.disabledAgents, []);
});

test('runRequest honours explicit guards + disabled agents', () => {
  const req = runRequest('sys_1', 'hi', { recursionLimit: 5, timeoutMs: 1000, disabledAgents: ['worker'] });
  assert.equal(req.recursionLimit, 5);
  assert.equal(req.timeoutMs, 1000);
  assert.deepEqual(req.disabledAgents, ['worker']);
});

test('principalFor scopes the OPA principal to os-<systemId>[:node]', () => {
  assert.equal(principalFor('sys_1'), 'os-sys_1');
  assert.equal(principalFor('sys_1', 'worker'), 'os-sys_1:worker');
});
