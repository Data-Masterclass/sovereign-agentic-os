/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tests for the gateway mirror's mapping and drift rules.
 *
 * USER STORY: As a platform admin I want certainty that the mirror never
 *             invents: an unreachable gateway reads as degraded rather than as a
 *             gateway with nothing in it, a key it cannot attribute is reported
 *             as drift rather than adopted, and a guardrail is only called
 *             fail-open when LiteLLM actually says so.
 *
 * ARCHITECTURE:
 *   Drives the PURE `buildMirror` with a fixed clock and hand-built source
 *   envelopes, so every rule is tested with no network and no cache. The IO
 *   shell (`readMirror`) is deliberately not tested here — it only fetches,
 *   caches and resolves counterparts, and holds no rules of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMirror, providerOf, ownerOf, spendByTag, type MirrorSources } from './gateway-mirror.ts';

const NOW = 1_700_000_000_000;
const good = <T>(data: T) => ({ ok: true as const, data });
const bad = (error = 'HTTP 500') => ({ ok: false as const, error });

/** Every source empty-but-reachable; each test overrides only what it asserts. */
function sources(over: Partial<MirrorSources> = {}): MirrorSources {
  return {
    models: good([]), groups: good([]), teams: good([]), keys: good([]),
    guardrails: good([]), spendReport: good([]), health: good({}), tags: good({}),
    ...over,
  };
}
const none = { domains: [], agents: [] };

test('GATEWAY-MIRROR: an unreachable model read is degraded, not an empty gateway', () => {
  const m = buildMirror(sources({ models: bad() }), none, NOW);
  assert.equal(m.degraded, true);
  assert.deepEqual(m.models, []);
});

test('GATEWAY-MIRROR: a reachable gateway with no models is NOT degraded', () => {
  assert.equal(buildMirror(sources(), none, NOW).degraded, false);
});

test('GATEWAY-MIRROR: one row per alias, deduped across deployments', () => {
  const m = buildMirror(sources({
    models: good([
      { model_name: 'chat', litellm_params: { model: 'openai/gpt-4o' } },
      { model_name: 'chat', litellm_params: { model: 'azure/gpt-4o' } },
    ]),
  }), none, NOW);
  assert.equal(m.models.length, 1);
  assert.equal(m.models[0].provider, 'openai');
});

test('GATEWAY-MIRROR: provider comes from the model prefix, else the api_base host', () => {
  assert.equal(providerOf({ litellm_params: { model: 'bedrock/claude' } }), 'bedrock');
  assert.equal(providerOf({ litellm_params: { model: 'gpt-4o', api_base: 'https://inference.stackit.cloud/v1' } }), 'inference.stackit.cloud');
  assert.equal(providerOf({}), 'unknown');
});

test('GATEWAY-MIRROR: a model LiteLLM reports unhealthy is marked unhealthy', () => {
  const m = buildMirror(sources({
    models: good([{ model_name: 'chat' }, { model_name: 'embed' }]),
    health: good({ unhealthy_endpoints: [{ model_name: 'chat' }] }),
  }), none, NOW);
  assert.equal(m.models.find((x) => x.id === 'chat')?.healthy, false);
  assert.equal(m.models.find((x) => x.id === 'embed')?.healthy, true);
});

test('GATEWAY-MIRROR: unknown health does not mark everything unhealthy', () => {
  const m = buildMirror(sources({ models: good([{ model_name: 'chat' }]), health: bad() }), none, NOW);
  assert.equal(m.models[0].healthy, true);
});

test('GATEWAY-MIRROR: a team whose alias names a known domain is governed', () => {
  const teams = good([{ team_id: 't1', team_alias: 'Finance', max_budget: 50, spend: 12 }]);
  assert.deepEqual(buildMirror(sources({ teams }), { domains: ['finance'], agents: [] }, NOW).unmanaged, []);
});

test('GATEWAY-MIRROR: a team with no matching OS domain is reported as unmanaged', () => {
  const teams = good([{ team_id: 't9', team_alias: 'someone-elses-team' }]);
  const m = buildMirror(sources({ teams }), { domains: ['finance'], agents: [] }, NOW);
  assert.deepEqual(m.unmanaged, [{ kind: 'team', id: 't9' }]);
});

test('GATEWAY-MIRROR: team budget and spend are carried through verbatim', () => {
  const teams = good([{ team_id: 't1', team_alias: 'finance', max_budget: 50, spend: 12.5, models: ['chat'] }]);
  const t = buildMirror(sources({ teams }), { domains: ['finance'], agents: [] }, NOW).teams[0];
  assert.deepEqual(t, { teamId: 't1', alias: 'finance', maxBudget: 50, spend: 12.5, models: ['chat'] });
});

test('GATEWAY-MIRROR: an absent budget is null, never 0', () => {
  const teams = good([{ team_id: 't1', team_alias: 'finance' }]);
  assert.equal(buildMirror(sources({ teams }), none, NOW).teams[0].maxBudget, null);
});

test('GATEWAY-MIRROR: an OS stamp beats the alias convention for key ownership', () => {
  assert.equal(ownerOf({ key_alias: 'svc-nightly', metadata: { os_owner: 'agent' } }), 'agent');
  assert.equal(ownerOf({ key_alias: 'agent-triage' }), 'agent');
  assert.equal(ownerOf({ key_alias: 'service-indexer' }), 'service');
  assert.equal(ownerOf({ key_alias: 'random' }), 'unknown');
});

test('GATEWAY-MIRROR: a blocked agent key stays attributed to its agent', () => {
  const keys = good([{ key_alias: 'agent-triage', blocked: true, spend: 3 }]);
  const m = buildMirror(sources({ keys }), { domains: [], agents: ['triage'] }, NOW);
  assert.deepEqual(m.keys, [{ alias: 'agent-triage', owner: 'agent', blocked: true, spend: 3 }]);
  assert.deepEqual(m.unmanaged, []);
});

test('GATEWAY-MIRROR: an unattributable key is drift', () => {
  const keys = good([{ key_alias: 'hand-made', spend: 1 }]);
  const m = buildMirror(sources({ keys }), { domains: [], agents: ['triage'] }, NOW);
  assert.deepEqual(m.unmanaged, [{ kind: 'key', id: 'hand-made' }]);
});

test('GATEWAY-MIRROR: a guardrail is fail-open only when LiteLLM says so', () => {
  const guardrails = good([
    { guardrail_name: 'presidio-pii', litellm_params: { guardrail: 'presidio' } },
    { guardrail_name: 'lakera', litellm_params: { guardrail: 'lakera_v2', fail_open: true } },
  ]);
  const g = buildMirror(sources({ guardrails }), none, NOW).guardrails;
  assert.deepEqual(g[0], { name: 'presidio-pii', provider: 'presidio', failOpen: false });
  assert.equal(g[1].failOpen, true);
});

test('GATEWAY-MIRROR: tagged spend lands in its own dimension', () => {
  const s = spendByTag(good({
    results: [
      { tag: 'domain:finance', metrics: { spend: 10 } },
      { tag: 'domain:finance', metrics: { spend: 5 } },
      { tag: 'agent:triage', metrics: { spend: 2 } },
      { tag: 'tab:knowledge', metrics: { spend: 1 } },
    ],
  }));
  assert.deepEqual(s.byDomain, { finance: 15 });
  assert.deepEqual(s.byAgent, { triage: 2 });
  assert.deepEqual(s.byTab, { knowledge: 1 });
});

test('GATEWAY-MIRROR: a tag we do not own is ignored, not bucketed', () => {
  const s = spendByTag(good({ results: [{ tag: 'experiment:x', metrics: { spend: 9 } }, { tag: 'bare', metrics: { spend: 9 } }] }));
  assert.deepEqual(s, { byDomain: {}, byAgent: {}, byTab: {} });
});

test('GATEWAY-MIRROR: per-user spend sums across report rows', () => {
  const spendReport = good([
    { user_id: 'u1', spend: 1.5 },
    { user_id: 'u1', spend: 2 },
    { customer_id: 'u2', spend: 4 },
    { spend: 99 },
  ]);
  assert.deepEqual(buildMirror(sources({ spendReport }), none, NOW).spend.byUser, { u1: 3.5, u2: 4 });
});

test('GATEWAY-MIRROR: fetchedAt is the caller-supplied clock', () => {
  assert.equal(buildMirror(sources(), none, NOW).fetchedAt, NOW);
});
