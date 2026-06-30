/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertTenantAccess, currentTenantId, getTenant, updateTenant } from './tenant.ts';
import { assertGuarded, confirmationPhrase, GuardError } from './guard.ts';
import { compile, type CompileInput } from './policy-compiler.ts';
import { _reset as resetDomains, createDomain, setLayer, setArchived, listDomains, compilerView } from './domains.ts';
import { _reset as resetSec, addAllowlist, removeAllowlist, decideRequest, listRequests } from './security.ts';
import { _reset as resetModels, registerProviderKey, listProviderKeys, setEnabled, setDefault, setCap, getDefaults } from './models.ts';
import { billingView, offlineSpend } from './billing.ts';
import { _reset as resetBackups, restore, restorePhrase } from './backups.ts';
import { _resetAudit as resetAudit, listAudit } from './audit.ts';
import { _reset as resetPlugins, installPlugin, approvePlugin } from './plugins.ts';

// ---------------------------------------------------------------- isolation --
test('multi-tenant isolation: own tenant resolves, any other id is 403', () => {
  const own = currentTenantId();
  assert.equal(assertTenantAccess(own).id, own);
  assert.throws(() => assertTenantAccess('some-other-tenant'), (e: { status?: number }) => e.status === 403);
});

test('tenant envelope is updatable but id/createdAt are immutable', () => {
  const before = getTenant();
  const after = updateTenant({ envelopeEUR: 5000 });
  assert.equal(after.envelopeEUR, 5000);
  assert.equal(after.id, before.id);
  assert.equal(after.createdAt, before.createdAt);
  updateTenant({ envelopeEUR: before.envelopeEUR });
});

// -------------------------------------------------------------------- guard --
test('guard: exact phrase required; wrong/empty confirm is 412', () => {
  assert.equal(confirmationPhrase('restore', 'Postgres'), 'restore postgres');
  assert.equal(assertGuarded('restore', 'postgres', 'restore postgres'), 'restore postgres');
  assert.throws(() => assertGuarded('restore', 'postgres', 'yes'), (e) => e instanceof GuardError && (e as GuardError).status === 412);
  assert.throws(() => assertGuarded('restore', 'postgres', ''), GuardError);
});

// --------------------------------------------------------- policy compiler --
test('policy compiler: role + active-user + domain-layer → OPA grants', () => {
  const input: CompileInput = {
    tenant: 'data-masterclass',
    users: [
      { id: 'sara', role: 'admin', domains: ['sales'] },
      { id: 'amir', role: 'participant', domains: ['sales'] },
      { id: 'ghost', role: 'builder', domains: ['sales'], active: false },
    ],
    domains: [{ id: 'sales', layers: { ml: true, spark: false } }],
    egressAllowlist: ['Github.com', 'github.com', 'api.example.com'],
  };
  const out = compile(input);
  // admin gets admin tooling; participant does not.
  assert.ok(out.grants['user:sara'].includes('admin'));
  assert.ok(out.grants['user:sara'].includes('backups.restore'));
  assert.ok(!out.grants['user:amir'].includes('admin'));
  // ml.enabled on the domain → the ml grant follows for members + the domain.
  assert.ok(out.grants['user:amir'].includes('ml'));
  assert.ok(out.grants['domain:sales'].includes('ml'));
  // deactivated user grants nothing.
  assert.equal(out.grants['user:ghost'], undefined);
  // egress allowlist is normalized + de-duped.
  assert.deepEqual(out.egressAllow, ['api.example.com', 'github.com']);
});

test('policy compiler: archived domain drops its grants', () => {
  const out = compile({
    tenant: 't', users: [{ id: 'u', role: 'participant', domains: ['old'] }],
    domains: [{ id: 'old', archived: true, layers: { ml: true, spark: false } }],
    egressAllowlist: [],
  });
  assert.equal(out.grants['domain:old'], undefined);
  assert.ok(!out.grants['user:u'].includes('ml'));
});

// ------------------------------------------------------------------ domains --
test('domains: create from template, toggle a layer, archive guards layers', () => {
  resetDomains();
  const d = createDomain({ name: 'Marketing', owner: 'sara', template: 'science' });
  assert.equal(d.id, 'marketing');
  assert.equal(d.layers.ml, true); // science template enables ML
  setLayer('marketing', 'spark', true);
  assert.equal(listDomains().find((x) => x.id === 'marketing')?.layers.spark, true);
  setArchived('marketing', true);
  assert.throws(() => setLayer('marketing', 'ml', false), (e: { status?: number }) => e.status === 409);
  // compiler view reflects archived + layers
  assert.equal(compilerView().find((x) => x.id === 'marketing')?.archived, true);
});

test('domains: duplicate create is 409', () => {
  resetDomains();
  createDomain({ name: 'Ops', owner: 'a' });
  assert.throws(() => createDomain({ name: 'Ops', owner: 'b' }), (e: { status?: number }) => e.status === 409);
});

// ----------------------------------------------------------------- security --
test('security: allowlist add/remove + approve request joins allowlist', () => {
  resetSec();
  addAllowlist('https://api.acme.io/v1');
  assert.ok(listRequests().length >= 1);
  const reqId = listRequests()[0].id;
  const { host } = decideRequest(reqId, 'approved');
  assert.ok(host && host.includes('.'));
  removeAllowlist('api.acme.io');
});

test('security: bad host is rejected', () => {
  resetSec();
  assert.throws(() => addAllowlist('not-a-host'), (e: { status?: number }) => e.status === 400);
});

// ------------------------------------------------------------------- models --
test('models: provider keys hold ONLY a ref + fingerprint — never a raw value', () => {
  resetModels();
  const pk = registerProviderKey({
    provider: 'openai',
    ref: { name: 'provider-openai', key: 'api_key' },
    fingerprint: 'sha256:abc123def456',
    addedBy: 'sara',
  });
  assert.equal(pk.fingerprint, 'sha256:abc123def456');
  const serialized = JSON.stringify(listProviderKeys());
  assert.ok(!/value|secret|raw|sk-/.test(serialized), 'no raw secret material may be serialized');
  assert.equal((pk as Record<string, unknown>).value, undefined);
});

test('models: cannot disable a default; cannot default a disabled/mismatched model', () => {
  resetModels();
  assert.throws(() => setEnabled('ministral-8b', false), (e: { status?: number }) => e.status === 409); // it is the chat default
  assert.throws(() => setDefault('embedding', 'ministral-8b'), (e: { status?: number }) => e.status === 400);
  setCap('stackit-llama-70b', 150);
  setEnabled('stackit-llama-70b', true);
  setDefault('chat', 'stackit-llama-70b');
  assert.equal(getDefaults().chat, 'stackit-llama-70b');
});

// ------------------------------------------------------------------ billing --
test('billing: usage-vs-envelope, hard-stop at/over the cap', () => {
  const { spendEUR, premiumSpendEUR, trend } = offlineSpend(2000);
  const v = billingView({ envelopeEUR: 2000, premiumCapEUR: 400, spendEUR, premiumSpendEUR, trend, source: 'offline-mock' });
  assert.equal(v.pctUsed, 62);
  assert.equal(v.hardStop, false);
  const over = billingView({ envelopeEUR: 1000, premiumCapEUR: 100, spendEUR: 1000, premiumSpendEUR: 120, trend: [], source: 'offline-mock' });
  assert.equal(over.hardStop, true);
  assert.equal(over.premiumHardStop, true);
});

// ------------------------------------------------------------------ backups --
test('backups: restore is GUARDED (412 without confirm) and AUDITED on success', () => {
  resetAudit();
  resetBackups();
  assert.equal(restorePhrase('postgres'), 'restore postgres');
  assert.throws(
    () => restore({ targetId: 'postgres', confirm: 'go', tenant: 't', actor: 'sara', role: 'admin' }),
    (e: { status?: number }) => e.status === 412,
  );
  const { job, audit } = restore({ targetId: 'postgres', confirm: 'restore postgres', tenant: 't', actor: 'sara', role: 'admin' });
  assert.equal(job.status, 'running');
  assert.equal(audit.guarded, true);
  const trail = listAudit({ prefix: 'backups.restore' });
  assert.equal(trail.length, 1);
  assert.equal(trail[0].action, 'backups.restore');
});

// ------------------------------------------------------------------ plugins --
test('plugins: unsigned plugin cannot be installed; approve requires install', () => {
  resetPlugins();
  assert.throws(() => installPlugin('forecast-skill'), (e: { status?: number }) => e.status === 409); // unsigned/unscanned
  assert.throws(() => approvePlugin('forecast-skill', ['sales']), (e: { status?: number }) => e.status === 409);
  const p = approvePlugin('notion-mcp', ['sales', 'finance']);
  assert.deepEqual(p.allowedDomains, ['sales', 'finance']);
});
