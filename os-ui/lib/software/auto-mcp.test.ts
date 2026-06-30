/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolsFromOpenApi, applyReadsOnWritesOff, generateAndCompile } from './auto-mcp.ts';
import { authorizeConnectionCall } from '@/lib/agent-governed';

const SPEC = {
  paths: {
    '/renewals': {
      get: { operationId: 'list_renewals', summary: 'List renewals (read).' },
      post: { operationId: 'add_renewal', summary: 'Add a renewal (write).' },
    },
    '/renewals/{id}': { get: { operationId: 'get_renewal' } },
  },
};

test('OpenAPI → tools: GET is read, POST is write (reads-on/writes-off preset)', () => {
  const tools = toolsFromOpenApi(SPEC);
  const list = tools.find((t) => t.name === 'list_renewals');
  const add = tools.find((t) => t.name === 'add_renewal');
  assert.equal(list?.write, false);
  assert.equal(list?.mode, 'Read');
  assert.equal(add?.write, true);
  assert.equal(add?.mode, 'Write-approval'); // writes are NOT auto-enabled
});

test('applyReadsOnWritesOff never auto-enables a write', () => {
  const t = applyReadsOnWritesOff([
    { name: 'r', description: '', write: false },
    { name: 'w', description: '', write: true },
  ]);
  assert.equal(t[0].mode, 'Read');
  assert.equal(t[1].mode, 'Write-approval');
});

test('compileToOpa governs the app MCP identically to any Connection', () => {
  const principal = 'app-test-renewals';
  generateAndCompile(principal, { openapi: SPEC });
  // Reads allow; writes require approval; an undeclared tool is denied.
  assert.equal(authorizeConnectionCall(principal, 'list_renewals').effect, 'allow');
  assert.equal(authorizeConnectionCall(principal, 'add_renewal').effect, 'requires_approval');
  assert.equal(authorizeConnectionCall(principal, 'drop_everything').effect, 'deny');
});
