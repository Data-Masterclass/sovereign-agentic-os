/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHermesProfile,
  assertNoBypass,
  toolsIncludeForPreset,
  type ProvisionInput,
  type ProfilePreset,
} from './provisioner.ts';
import { resolveAutonomous } from '../governance/governance.ts';

const TOOLS = [
  { name: 'query_data', write: false },
  { name: 'search_knowledge', write: false },
  { name: 'connection_crm_write', write: true },
];

function input(preset: ProfilePreset): ProvisionInput {
  return {
    identity: { user: 'alice', domain: 'sales' },
    preset,
    availableTools: TOOLS,
    model: {
      litellmBaseUrl: 'http://agentic-os-litellm:4000/v1',
      model: 'hermes-4-3-14b',
      apiKeyRef: 'secret://hermes-litellm-key',
      providerKeys: {},
    },
    mcp: { url: 'http://os-ui:3000/api/mcp', auth: { kind: 'oauth', tokenRef: 'secret://ory-token' } },
    runtimeClass: 'gvisor',
    egressAllowlist: ['agentic-os-litellm', 'os-ui', 'egress-proxy'],
  };
}

test('one profile per (user, domain), agent runs as the user', () => {
  const p = buildHermesProfile(input('read-bounded'));
  assert.equal(p.identity.user, 'alice');
  assert.equal(p.identity.domain, 'sales');
  assert.equal(p.profileId, 'hermes-alice-sales');
});

test('preset → approvals.mode mapping matches the governance table EXACTLY', () => {
  assert.equal(buildHermesProfile(input('in-tab')).approvals.mode, 'manual');
  assert.equal(buildHermesProfile(input('read-only')).approvals.mode, 'manual');
  assert.equal(buildHermesProfile(input('read-propose')).approvals.mode, 'manual');
  assert.equal(buildHermesProfile(input('read-bounded')).approvals.mode, 'smart');
  assert.equal(buildHermesProfile(input('full-in-scope')).approvals.mode, 'smart');
});

test('read-only exposes ONLY read tools; other presets keep writes', () => {
  assert.deepEqual(toolsIncludeForPreset('read-only', TOOLS), ['query_data', 'search_knowledge']);
  assert.ok(toolsIncludeForPreset('read-bounded', TOOLS).includes('connection_crm_write'));
});

test('read-only denies cron autonomy; bounded/full allow it', () => {
  assert.equal(buildHermesProfile(input('read-only')).cron_mode, 'deny');
  assert.equal(buildHermesProfile(input('full-in-scope')).cron_mode, 'allow');
});

test('command_allowlist is empty for read presets, curated (non-wildcard) for bounded/full', () => {
  assert.deepEqual(buildHermesProfile(input('read-only')).command_allowlist, []);
  const cmds = buildHermesProfile(input('read-bounded')).command_allowlist;
  assert.ok(cmds.length > 0);
  assert.ok(!cmds.includes('*') && !cmds.some((c) => /sh$|bash$/.test(c)));
});

test('no-bypass floors hold: LiteLLM-only, no provider keys, real sandbox, lazy-installs off', () => {
  const p = buildHermesProfile(input('full-in-scope'));
  assert.deepEqual(assertNoBypass(p), []);
  assert.equal(Object.keys(p.model.providerKeys).length, 0);
  assert.equal(p.security.allow_lazy_installs, false);
  assert.equal(p.security.ssrf_protection, true);
  assert.equal(p.secretsSource, 'secrets-manager');
  assert.ok(p.security.website_blocklist.includes('169.254.169.254'));
});

test('assertNoBypass CATCHES a tampered profile (direct provider key + host sandbox)', () => {
  const p = buildHermesProfile(input('full-in-scope'));
  // Simulate an off-gateway tamper.
  (p.model.providerKeys as Record<string, string>).OPENAI_API_KEY = 'sk-live';
  p.sandbox.runtimeClass = 'host';
  p.security.allow_lazy_installs = true as unknown as false;
  const v = assertNoBypass(p);
  const props = v.map((x) => x.property);
  assert.ok(props.includes('provider-keys'));
  assert.ok(props.includes('sandbox'));
  assert.ok(props.includes('lazy-installs'));
});

// --- Integration with the shared autonomous governance (Mode B) ---------------
// The gate items "out-of-scope tool → blocked + queued" and "write beyond preset
// → approval/blocked" are enforced by the SAME resolveAutonomous the LangGraph
// agents use — Hermes gets no side door.

test('out-of-scope tool (OPA deny) → block + queued to Governance', () => {
  const d = resolveAutonomous('full-in-scope', { effect: 'deny', reason: 'not granted' }, 'Read', false);
  assert.equal(d.effect, 'block');
  assert.equal(d.queue, true);
});

test('write beyond a read-only preset → blocked + queued', () => {
  const d = resolveAutonomous('read-only', { effect: 'allow', reason: 'granted' }, 'Write-bounded', true);
  assert.equal(d.effect, 'block');
  assert.equal(d.queue, true);
});

test('bounded write within limit runs; approval-write is queued', () => {
  const ok = resolveAutonomous('read-bounded', { effect: 'allow', reason: 'in bound' }, 'Write-bounded', true);
  assert.equal(ok.effect, 'allow');
  const held = resolveAutonomous('read-bounded', { effect: 'requires_approval', reason: 'needs sign-off' }, 'Write-approval', true);
  assert.equal(held.effect, 'block');
  assert.equal(held.queue, true);
});
