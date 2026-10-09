/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindPlatformMcp, validateBinding, visibleTools } from './mcp-binding.ts';

const OAUTH = { kind: 'oauth' as const, tokenRef: 'secret://ory-token-alice' };

test('binds the Platform MCP over HTTP with the user Ory OAuth token', () => {
  const b = bindPlatformMcp({
    identity: { user: 'alice', domain: 'sales' },
    mcpUrl: 'http://os-ui:3000/api/mcp',
    auth: OAUTH,
    toolsInclude: ['query_data', 'search_knowledge'],
  });
  assert.equal(b.server.transport, 'http');
  assert.equal(b.principal, 'alice');
  assert.equal(b.domain, 'sales');
  assert.deepEqual(validateBinding(b), []);
});

test('mTLS binding is valid for a service agent', () => {
  const b = bindPlatformMcp({
    identity: { user: 'ops-agent', domain: 'platform' },
    mcpUrl: 'http://os-ui:3000/api/mcp/agents',
    auth: { kind: 'mtls', certRef: 'secret://cert', keyRef: 'secret://key' },
    toolsInclude: ['list_agent_systems'],
  });
  assert.deepEqual(validateBinding(b), []);
});

test('rejects an unauthenticated, non-MCP, or empty-tools binding', () => {
  const bad = bindPlatformMcp({
    identity: { user: 'x', domain: 'y' },
    mcpUrl: 'http://provider.example.com/v1',
    auth: { kind: 'oauth', tokenRef: '' },
    toolsInclude: [],
  });
  const props = validateBinding(bad).map((v) => v.property);
  assert.ok(props.includes('auth'));
  assert.ok(props.includes('tools'));
  assert.ok(props.includes('url'));
});

test('a profile sees only the intersection of offered tools and tools.include', () => {
  const offered = ['query_data', 'search_knowledge', 'connection_crm_write'];
  assert.deepEqual(visibleTools(offered, ['query_data', 'search_knowledge']), ['query_data', 'search_knowledge']);
  // A tool NOT in tools.include is invisible (and, if called, OPA denies it).
  assert.ok(!visibleTools(offered, ['query_data']).includes('connection_crm_write'));
});

test('two users bind as different principals → RLS scopes to different rows', () => {
  const a = bindPlatformMcp({ identity: { user: 'alice', domain: 'sales' }, mcpUrl: 'http://os-ui:3000/api/mcp', auth: OAUTH, toolsInclude: ['query_data'] });
  const b = bindPlatformMcp({ identity: { user: 'bob', domain: 'finance' }, mcpUrl: 'http://os-ui:3000/api/mcp', auth: { kind: 'oauth', tokenRef: 'secret://ory-token-bob' }, toolsInclude: ['query_data'] });
  assert.notEqual(a.principal, b.principal);
  assert.notEqual(a.domain, b.domain);
});
