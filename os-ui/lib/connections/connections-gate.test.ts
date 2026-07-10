/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Validation-gate test for the Connections tab, exercised over the PURE decision
 * spine (compiler + adapters + governance + data-handoff + egress) — the same
 * functions the server-only `lib/connections.ts` delegates to. Walks the golden-
 * path gate end to end so the policy behaviour is provable with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateByKey } from './schema.ts';
import { adapterFor } from './connection-adapters.ts';
import { compileConnectionProfile, decide, exposedTools } from '../infra/capability-compiler.ts';
import {
  rememberPolicy,
  matchStandingPolicy,
  resolveAutonomous,
  effectivePreset,
  setAgentPreset,
  _clearStandingPolicies,
  _clearPresets,
} from '../governance/governance.ts';
import { registerBronzeSource, bronzeFor, _clearHandoffs } from '../data/data-handoff.ts';
import { requestEgress, decideEgress, isHostApproved, _clearEgress } from './egress-requests.ts';

function bundleFor(templateKey: string, grants: { agent: string; tools: string[] }[] = []) {
  const tpl = templateByKey(templateKey)!;
  const tools = tpl.tools.map((t) => ({ name: t.name, mode: t.mode, write: t.write, maxAmount: t.limits?.maxAmount }));
  return compileConnectionProfile(`conn-${templateKey}`, tools, grants);
}

test('GATE: a user connects their own Google Drive via personal OAuth (token minted, never in record)', async () => {
  const tpl = templateByKey('gdrive')!;
  assert.equal(tpl.auth, 'oauth'); // personal-connectable by ANY user
  const auth = await adapterFor('drive').auth({ template: tpl, endpoint: tpl.endpointHint, credentialPresent: false, authCode: 'consent' });
  assert.ok(auth.data?.secretValue.length, 'a token is minted (server-side) for Secrets Manager');
  // exposed Drive tools are reads; writes start Off/Blocked (safe preset)
  const b = bundleFor('gdrive');
  assert.deepEqual(exposedTools(b).sort(), ['list_files', 'read_file', 'search_files']);
});

test('GATE: capability profile honoured — Off hidden, Read works, Blocked cannot run', () => {
  const b = bundleFor('database');
  assert.ok(exposedTools(b).includes('query')); // Read exposed
  assert.ok(!exposedTools(b).includes('write_row')); // Off hidden
  assert.equal(decide(b, 'query').effect, 'allow');
  assert.equal(decide(b, 'drop_table').effect, 'deny'); // Blocked
  assert.equal(decide(b, 'write_row').effect, 'deny'); // Off
});

test('GATE: Postgres is BOTH a Bronze source AND a query tool (one object, two usages)', async () => {
  _clearHandoffs();
  const sync = await adapterFor('database').sync({ template: templateByKey('database')!, endpoint: 'postgres://x', credentialPresent: true });
  registerBronzeSource({ connectionId: 'conn-pg', name: 'Orders DB', connector: 'database', rows: sync.data?.records ?? 0, registeredBy: 'bob' });
  assert.equal(bronzeFor('conn-pg')?.table, 'bronze.orders_db'); // data source
  const b = bundleFor('database');
  assert.equal(decide(b, 'query').effect, 'allow'); // still a tool at the same time
});

test('GATE: Write-bounded allowed in-limit, denied out; Write-approval pauses; approve&remember → standing policy', () => {
  _clearStandingPolicies();
  const b = compileConnectionProfile('conn-sf', [
    { name: 'read_opportunity', mode: 'Read', write: false },
    { name: 'update_opportunity_amount', mode: 'Write-bounded', write: true, maxAmount: 50000 },
    { name: 'create_case', mode: 'Write-approval', write: true },
  ]);
  assert.equal(decide(b, 'update_opportunity_amount', { amount: 40000 }).effect, 'allow');
  assert.equal(decide(b, 'update_opportunity_amount', { amount: 60000 }).effect, 'deny');
  assert.equal(decide(b, 'create_case').effect, 'requires_approval'); // pauses inline
  // approve & remember → identical calls auto-allow (no more prompt)
  assert.equal(matchStandingPolicy('conn-sf', 'create_case', {}), null);
  rememberPolicy({ principal: 'conn-sf', tool: 'create_case', createdBy: 'alice' });
  assert.ok(matchStandingPolicy('conn-sf', 'create_case', {}));
});

test('GATE: approve-once ceiling — an inline approver can never execute Off/Blocked/over-bound', () => {
  // `approveOnce` (lib/connections.ts, Mode A) re-authorizes with this exact decision
  // before executing, and only runs when the effect is NOT 'deny'. So the capability
  // profile stays the ceiling: approving cannot broaden it.
  const b = compileConnectionProfile('conn-sf', [
    { name: 'read_opportunity', mode: 'Read', write: false },
    { name: 'update_opportunity_amount', mode: 'Write-bounded', write: true, maxAmount: 50000 },
    { name: 'create_case', mode: 'Write-approval', write: true },
    { name: 'mass_update', mode: 'Off', write: true },
    { name: 'delete_record', mode: 'Blocked', write: true },
  ]);
  assert.equal(decide(b, 'mass_update').effect, 'deny'); // Off — refused even by an approver
  assert.equal(decide(b, 'delete_record').effect, 'deny'); // Blocked — refused even by an approver
  assert.equal(decide(b, 'update_opportunity_amount', { amount: 60000 }).effect, 'deny'); // over-bound
  // Genuinely held (requires_approval) → an approver may resume and run it once.
  assert.equal(decide(b, 'create_case').effect, 'requires_approval');
});

test('GATE: a Builder attaches the MCP to ONE agent — another agent cannot see it', () => {
  const b = bundleFor('generic-mcp', [{ agent: 'agent-one', tools: ['search', 'fetch'] }]);
  assert.equal(decide(b, 'search', {}, 'agent-one').effect, 'allow');
  // agent-two has a grant entry that excludes the tool ⇒ denied (least privilege)
  const b2 = bundleFor('generic-mcp', [{ agent: 'agent-two', tools: [] }]);
  assert.equal(decide(b2, 'search', {}, 'agent-two').effect, 'deny');
});

test('GATE: an autonomous out-of-policy action is BLOCKED and queued for review', () => {
  _clearPresets();
  setAgentPreset('auto-agent', 'read-bounded');
  const preset = effectivePreset('auto-agent', 'sales', 'conn-sf', 'create_case');
  // create_case is Write-approval → read-bounded blocks + queues (no inline prompt)
  const profile = decide(compileConnectionProfile('conn-sf', [{ name: 'create_case', mode: 'Write-approval', write: true }]), 'create_case');
  const a = resolveAutonomous(preset, profile, 'Write-approval', true);
  assert.equal(a.effect, 'block');
  assert.ok(a.queue, 'queued to the Governance inbox');
});

test('GATE: a new egress endpoint is Admin-approved before a connection can reach it', () => {
  _clearEgress();
  assert.equal(isHostApproved('api.partner.com'), false); // default-deny
  const r = requestEgress({ host: 'api.partner.com', domain: 'sales', reason: 'partner API', requestedBy: 'bob' });
  assert.equal(isHostApproved('api.partner.com'), false); // still denied while pending
  decideEgress(r.id, 'approve', 'admin');
  assert.ok(isHostApproved('api.partner.com')); // approved ⇒ now reachable (and logged)
});
