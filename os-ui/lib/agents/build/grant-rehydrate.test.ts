/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * DURABLE GRANT REHYDRATION — the self-healing fix for the "flip-flop" where a
 * governed agent's `query_data` denies after an os-ui pod restart wipes the
 * in-memory grant registry.
 *
 * Proven here:
 *   1. Cold registry (empty GRANTS) + a persisted agent record granting `query_data`
 *      ⇒ `authorizeAppTool('os-<id>', 'query_data')` returns ALLOW after the record
 *      is rehydrated on the first call (no rebuild).
 *   2. FAIL-CLOSED: a principal with NO persisted record stays DENIED (falls through
 *      to the OPA/offline mirror, which does not know the dynamic principal).
 *   3. The rehydrated grant is cached back so the second call is the sync fast path.
 *   4. The resolver reproduces the Build vocabulary EXACTLY (raw ∪ resolved MCP ∪
 *      connection tools) and never broadens.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystem, serializeSystem, type System } from '../system-schema.ts';
import { resolveAgentGrants } from './grant-rehydrate.ts';
import {
  grantsFor,
  grantsForDurable,
  registerDurableGrantResolver,
  type DurableGrantResolver,
} from '@/lib/app-registry';
import { authorizeAppTool } from '@/lib/agent-governed';

/** A persisted agent system: grants span data (query_data) + knowledge. */
function persistedYaml(): string {
  const sys: System = parseSystem({
    version: '1',
    system: { name: 'Campaign', domain: 'marketing', visibility: 'Personal' },
    runtime: 'langgraph',
    entrypoint: 'analyst',
    grants: { tools: ['query_data', 'retrieve'] },
    agents: [{ id: 'analyst', role: 'agent', agent_md: 'You analyse.', memory_md: '' }],
  });
  return serializeSystem(sys);
}

const GRANTS_KEY = Symbol.for('soa.app-registry.state');
const RESOLVER_KEY = Symbol.for('soa.app-registry.grantResolver');

/** Simulate a fresh pod: empty in-memory grant registry + no resolver. */
function coldRegistry(): void {
  const g = globalThis as unknown as Record<symbol, { grants: Map<string, unknown>; conns: Map<string, unknown> } | undefined>;
  if (g[GRANTS_KEY]) g[GRANTS_KEY]!.grants.clear();
  delete (globalThis as unknown as Record<symbol, DurableGrantResolver | undefined>)[RESOLVER_KEY];
}

beforeEach(() => coldRegistry());

test('resolveAgentGrants reproduces the Build vocabulary from the persisted record', async () => {
  const yaml = persistedYaml();
  const tools = await resolveAgentGrants('os-sys_abc', () => ({ yaml }));
  assert.ok(tools, 'a known agent principal resolves');
  // raw grants kept (so raw-IR tool calls stay authorized) + resolved MCP name for
  // the legacy `retrieve` alias (search_knowledge). No broadening.
  assert.ok(tools!.includes('query_data'), 'raw query_data grant present');
  assert.ok(tools!.includes('retrieve'), 'raw retrieve grant present');
  assert.ok(tools!.includes('search_knowledge'), 'retrieve resolves to its MCP name');
});

test('FAIL-CLOSED: a non-agent principal resolves to null', async () => {
  const r = await resolveAgentGrants('sales-assistant', () => ({ yaml: persistedYaml() }));
  assert.equal(r, null);
});

test('FAIL-CLOSED: an unknown system (no persisted record) resolves to null', async () => {
  const r = await resolveAgentGrants('os-ghost', () => null);
  assert.equal(r, null);
});

test('SELF-HEAL: cold registry + persisted record ⇒ authorizeAppTool allows query_data', async () => {
  const yaml = persistedYaml();
  // Wire the durable resolver as the govern route does — but with an in-memory
  // store stub so the test needs no live OpenSearch.
  registerDurableGrantResolver((principal) => resolveAgentGrants(principal, (id) => (id === 'sys_abc' ? { yaml } : null)));

  // Cold: nothing in the in-memory registry yet.
  assert.deepEqual(grantsFor('os-sys_abc'), [], 'registry starts empty (post-restart)');

  const authz = await authorizeAppTool('os-sys_abc', 'query_data');
  assert.equal(authz.effect, 'allow', 'the built agent self-heals its grant on first call');
  assert.equal(authz.policy, 'app-grant');

  // Cached back: the second call is the fast sync path (grant now in the registry).
  assert.ok(grantsFor('os-sys_abc').includes('query_data'), 'grant cached back into the registry');
});

test('FAIL-CLOSED: a principal with NO persisted record stays denied', async () => {
  const yaml = persistedYaml();
  registerDurableGrantResolver((principal) => resolveAgentGrants(principal, (id) => (id === 'sys_abc' ? { yaml } : null)));

  // Different, unbuilt system id ⇒ resolver returns null ⇒ no grant ⇒ falls through
  // to OPA/offline mirror, which does not know this dynamic principal ⇒ deny.
  const authz = await authorizeAppTool('os-sys_unknown', 'query_data');
  assert.notEqual(authz.effect, 'allow', 'an unbuilt/absent system is never granted');
});

test('a resolver that throws never grants (fail-closed)', async () => {
  registerDurableGrantResolver(async () => {
    throw new Error('store unreachable');
  });
  const tools = await grantsForDurable('os-sys_abc');
  assert.deepEqual(tools, [], 'a failed durable lookup grants nothing');
});
