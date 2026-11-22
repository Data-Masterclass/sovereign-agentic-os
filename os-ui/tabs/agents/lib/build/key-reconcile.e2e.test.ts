/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The continuous key reconcile, proven against the REAL LiteLLM image.
 * USER STORY: As the owner I need proof from the real gateway, not a fake, that a key edited in
 *             LiteLLM's own admin API is reported as drift by the OS, that the OS leaves the edit
 *             alone by default, and that a system an admin switched to auto-correct is put back.
 * ARCHITECTURE:
 *   - Runs ONLY against the containers started by scripts/tests/agent-key-migration/run.sh (the
 *     chart's LiteLLM image on a real Postgres). Without them the suite SKIPS, saying so; with
 *     AGENT_KEY_MIGRATION_E2E_REQUIRED=1 a missing gateway is a FAILURE.
 *   - The OS side is the production code over the real client (`realLitellm`: /key/list with
 *     return_full_object, /key/generate, /key/update). The "platform team's edit" is made with
 *     the gateway's own admin API directly (/key/update, /key/delete), exactly as LiteLLM's UI does.
 *   - NEGATIVE TWINS: a freshly built key must reconcile as IN SYNC on the real read-back (so
 *     "drift" is not a mapping artefact); an edit must be seen (a reconcile that never reads the
 *     gateway would stay green); the default pass must not write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deriveKek, memorySystemKeyJournal, memorySystemKeyStore, tokenIdOf, openSystemKey } from '@core/infra/agent-system-keys';
import { realLitellm } from '@tabs/agents/lib/build/live-clients';
import { makeLiveAdapters, type LiveDeps } from '@tabs/agents/lib/build/live';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import { reapplyAudited, runKeyReconcile, type KeyReconcileIo } from '@tabs/agents/lib/build/key-reconcile';

const GW = (process.env.LITELLM_URL ?? '').replace(/\/+$/, '');
const MASTER = process.env.LITELLM_MASTER_KEY ?? '';
const REQUIRED = process.env.AGENT_KEY_MIGRATION_E2E_REQUIRED === '1';
if (REQUIRED && (!GW || !MASTER)) throw new Error('AGENT_KEY_MIGRATION_E2E_REQUIRED=1 but LITELLM_URL / LITELLM_MASTER_KEY are not set');
const skip = GW && MASTER && REQUIRED ? false : 'run scripts/tests/agent-key-migration/run.sh (needs the real LiteLLM image)';

const KEK = deriveKek('e2e-key-encryption-secret-0123456789abcdef');
const YAML = `
system: { name: Desk, domain: sales, visibility: Personal }
entrypoint: worker
grants:
  tools: [retrieve]
agents:
  - { id: worker, role: w, agent_md: "# Worker", memory_md: "", tools: [retrieve], model: sovereign-default }
`;

const admin = (path: string, body: unknown) =>
  fetch(`${GW}${path}`, { method: 'POST', headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** What the gateway itself holds for the key with this alias (its own /key/list, not the OS's mapping). */
async function gatewayKey(alias: string): Promise<{ token: string; max_budget: number | null; models: string[]; metadata: Record<string, unknown> | null } | undefined> {
  const res = await fetch(`${GW}/key/list?key_alias=${encodeURIComponent(alias)}&return_full_object=true&size=10`, { headers: { authorization: `Bearer ${MASTER}` } });
  const body = (await res.json()) as { keys?: { key_alias?: string; token: string; max_budget: number | null; models: string[]; metadata: Record<string, unknown> | null }[] };
  return (body.keys ?? []).find((k) => k.key_alias === alias);
}
const auth = async (key: string) => (await fetch(`${GW}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status;

function wire(id: string) {
  const store = memorySystemKeyStore();
  const deps: LiveDeps = {
    opa: { putGrants: async () => undefined, mergeRequiresApproval: async () => undefined, decision: async () => ({ effect: 'allow', reason: '' }) },
    litellm: realLitellm(),
    langfuse: { ensureProject: async () => undefined, tracesFor: async () => 0 },
    keys: { store, journal: memorySystemKeyJournal(), kek: () => KEK, retireGraceSeconds: 0 },
    caps: { maxBudget: 5, budgetDuration: '7d', modelMaxBudget: {}, rpmLimit: 300, tpmLimit: 1_000_000, maxParallelRequests: 8 },
    runModels: () => ['sovereign-default'],
  };
  const audits: { action: string; subject: string }[] = [];
  const io = (over: Partial<KeyReconcileIo> = {}): KeyReconcileIo => ({
    systems: async () => [{ id, domain: 'sales', owner: 'u1', yaml: YAML }],
    governYaml: async (y) => y,
    deps,
    autoCorrect: new Set<string>(),
    previous: null,
    log: () => undefined,
    audit: ((e: { action: string; subject: string }) => { audits.push(e); }) as never,
    ...over,
  });
  const build = () => orchestrateBuild({ yaml: YAML, systemId: id, adapters: makeLiveAdapters(deps).filter((a) => a.tool === 'litellm') });
  return { deps, io, build, audits, store };
}

test('REAL GATEWAY: a key the OS just built reconciles as IN SYNC (the real read-back maps cleanly: no false drift)', { skip }, async () => {
  const id = `rc_${randomBytes(4).toString('hex')}`;
  const t = wire(id);
  assert.equal((await t.build()).ok, true);
  const r = await runKeyReconcile(t.io());
  assert.deepEqual([r.ok, r.inSync, r.entries], [true, 1, []], JSON.stringify(r));
});

test('REAL GATEWAY: an edit made through LiteLLM\'s admin API is reported as drift and NOT overwritten (alert-only default)', { skip }, async () => {
  const id = `rc_${randomBytes(4).toString('hex')}`;
  const t = wire(id);
  await t.build();
  const value = openSystemKey((await t.store.get(id))!, KEK);

  // The platform team raises the budget and the rate limit in LiteLLM.
  assert.equal((await admin('/key/update', { key: tokenIdOf(value), max_budget: 500, rpm_limit: 7 })).status, 200);
  const r = await runKeyReconcile(t.io());
  assert.equal(r.entries.length, 1, JSON.stringify(r));
  assert.deepEqual([r.entries[0].kind, r.entries[0].action], ['drift', 'alert']);
  assert.ok(r.entries[0].changes.some((c) => c.startsWith('budget $500 → $5')), r.entries[0].changes.join('|'));
  assert.ok(r.entries[0].changes.some((c) => c.startsWith('requests/min 7 → 300')), r.entries[0].changes.join('|'));
  // NOT overwritten: the gateway still holds the platform team's value, and the key still works.
  assert.equal((await gatewayKey(`os-${id}`))!.max_budget, 500);
  assert.equal(await auth(value), 200);
  assert.equal(t.audits.length, 0, 'an alert-only pass writes nothing and audits nothing');
});

test('REAL GATEWAY: the allowed_tools stamp dropped in LiteLLM\'s UI (metadata replaced) is drift', { skip }, async () => {
  const id = `rc_${randomBytes(4).toString('hex')}`;
  const t = wire(id);
  await t.build();
  const value = openSystemKey((await t.store.get(id))!, KEK);
  assert.ok((await gatewayKey(`os-${id}`))!.metadata?.allowed_tools, 'precondition: the OS stamped allowed_tools');
  assert.equal((await admin('/key/update', { key: tokenIdOf(value), metadata: { note: 'edited by the platform team' } })).status, 200);
  const r = await runKeyReconcile(t.io());
  assert.equal(r.entries.length, 1, JSON.stringify(r));
  assert.match(r.entries[0].changes.join('|'), /allowed tools not recorded/);
});

test('REAL GATEWAY: a key deleted in LiteLLM is reported as missing', { skip }, async () => {
  const id = `rc_${randomBytes(4).toString('hex')}`;
  const t = wire(id);
  await t.build();
  const value = openSystemKey((await t.store.get(id))!, KEK);
  assert.equal((await admin('/key/delete', { keys: [tokenIdOf(value)] })).status, 200);
  const r = await runKeyReconcile(t.io());
  assert.deepEqual(r.entries.map((e) => [e.kind, e.action]), [['missing', 'alert']], JSON.stringify(r));
  assert.equal(await auth(value), 401, 'precondition of the alert: the gateway really refuses the key now');
});

test('REAL GATEWAY: auto-correct, enabled for THIS system only, puts the key back with the same value, audited', { skip }, async () => {
  const id = `rc_${randomBytes(4).toString('hex')}`;
  const t = wire(id);
  await t.build();
  const value = openSystemKey((await t.store.get(id))!, KEK);
  await admin('/key/update', { key: tokenIdOf(value), max_budget: 500 });

  // Another system's id in the list changes nothing for this one (negative twin).
  const other = await runKeyReconcile(t.io({ autoCorrect: new Set(['not_this_one']) }));
  assert.equal(other.entries[0].action, 'alert');
  assert.equal((await gatewayKey(`os-${id}`))!.max_budget, 500);

  const r = await runKeyReconcile(t.io({ autoCorrect: new Set([id]) }));
  assert.deepEqual(r.entries.map((e) => e.action), ['corrected'], JSON.stringify(r));
  const back = (await gatewayKey(`os-${id}`))!;
  assert.equal(back.max_budget, 5);
  assert.equal(back.token, tokenIdOf(value), 'the key value was not rotated');
  assert.equal(await auth(value), 200);
  assert.ok(t.audits.some((a) => a.action === 'gateway.key.reconcile' && a.subject === `os-${id}`));
  assert.equal((await runKeyReconcile(t.io({ autoCorrect: new Set([id]) }))).entries.length, 0, 'a second pass finds nothing');
});

test('REAL GATEWAY: an admin\'s re-apply puts a drifted key back, same value, with an audit entry', { skip }, async () => {
  const id = `rc_${randomBytes(4).toString('hex')}`;
  const t = wire(id);
  await t.build();
  const value = openSystemKey((await t.store.get(id))!, KEK);
  await admin('/key/update', { key: tokenIdOf(value), models: ['sovereign-default', 'something-extra'] });
  const drift = (await runKeyReconcile(t.io())).entries[0];
  assert.match(drift.changes.join('|'), /models/);
  const out = await reapplyAudited({ systemId: id, yaml: YAML, domain: 'sales', actor: 'u_admin', deps: t.deps, drift, audit: ((e: { action: string; subject: string }) => { t.audits.push(e); }) as never });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal((await runKeyReconcile(t.io())).entries.length, 0);
  assert.equal((await gatewayKey(`os-${id}`))!.token, tokenIdOf(value));
  assert.ok(t.audits.some((a) => a.action === 'gateway.key.reapply'));
});
