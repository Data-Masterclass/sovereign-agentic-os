/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Every encryption-key change asks for the admin's password again, is audited, and never leaks a key
 * USER STORY: As a security reviewer I want a stolen admin session to be unable to rotate, switch or
 *             export keys, and every attempt — successful or not — to be in the audit log.
 * ARCHITECTURE:
 *   - `runKeyOp` with injected `authenticate` / `audit` and the REAL key manager over a memory key
 *     record. Plus source checks for the install-wizard step (the pages are .tsx the harness cannot run).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runKeyOp, type KeyOpDeps } from '@tabs/admin/lib/encryption-keys';
import * as km from '@core/infra/key-manager';
import { memoryKeyStateStore } from '@core/infra/key-state';
import { rateLimitReset } from '@core/kernel/ratelimit';
import { ADMIN_SECTIONS } from '@tabs/admin/lib/sections';

const ENV = { OS_SECRETS_ENCRYPTION_KEY: 'c'.repeat(20) + 'test-master-key-0123456789abc' } as NodeJS.ProcessEnv;
const ctx = { user: { id: 'alice', role: 'admin' }, tenant: { id: 't1' } };

function harness() {
  const audits: { action: string; detail: string; result?: string }[] = [];
  let reloads = 0;
  const deps: KeyOpDeps = {
    authenticate: async (u, p) => (u === 'alice' && p === 'right-pw' ? { id: u } : null),
    audit: (e) => audits.push(e),
    km,
    reload: async () => { reloads++; },
  };
  return { deps, audits, reloads: () => reloads };
}

async function boot() {
  km.configureKeyManager({ store: memoryKeyStateStore(), env: ENV });
  await km.loadKeys();
  rateLimitReset('encryption-keys-reauth:alice');
}

test('no password / a wrong password: refused with reauth codes, audited as denied, nothing changes', async () => {
  await boot();
  const h = harness();
  const before = km.keyView().dataKeys[0].id;
  let r = await runKeyOp(ctx, { op: 'rotate', newDataKey: true }, h.deps);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'reauth-required');
  r = await runKeyOp(ctx, { op: 'rotate', newDataKey: true, password: 'wrong' }, h.deps);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'reauth-failed');
  assert.equal(km.keyView().dataKeys[0].id, before);
  assert.deepEqual(h.audits.map((a) => [a.action, a.result]), [['encryption-keys.rotate', 'denied'], ['encryption-keys.rotate', 'denied']]);
});

test('re-auth attempts are rate-limited per admin', async () => {
  await boot();
  const h = harness();
  for (let i = 0; i < 5; i++) await runKeyOp(ctx, { op: 'rotate', password: 'wrong' }, h.deps);
  const r = await runKeyOp(ctx, { op: 'rotate', password: 'right-pw' }, h.deps);
  assert.equal(r.status, 429, 'even the right password waits once the limit is hit');
  assert.equal(r.body.code, 'reauth-limited');
  rateLimitReset('encryption-keys-reauth:alice');
});

test('with the password: generate → confirm → rotate → test restore, each audited ok; the recovery key is never audited', async () => {
  await boot();
  const h = harness();
  const g = await runKeyOp(ctx, { op: 'recovery-generate', password: 'right-pw' }, h.deps);
  assert.equal(g.status, 200);
  const rk = String(g.body.recoveryKey);
  assert.match(rk, /^([A-Z2-9]{5}-){7}[A-Z2-9]{5}$/);
  assert.equal((await runKeyOp(ctx, { op: 'recovery-confirm', password: 'right-pw', recoveryKey: rk }, h.deps)).status, 400, 'confirm needs the explicit "I saved it"');
  assert.equal((await runKeyOp(ctx, { op: 'recovery-confirm', password: 'right-pw', saved: true }, h.deps)).status, 400, 'confirm needs the key typed back');
  assert.equal((await runKeyOp(ctx, { op: 'recovery-confirm', password: 'right-pw', saved: true, recoveryKey: rk }, h.deps)).status, 200);
  assert.equal((await runKeyOp(ctx, { op: 'rotate', password: 'right-pw', newDataKey: true }, h.deps)).status, 200);
  assert.equal(h.reloads(), 1, 'the store adopts the new keyring at once');
  const t = await runKeyOp(ctx, { op: 'test-restore', password: 'right-pw', recoveryKey: rk }, h.deps);
  assert.deepEqual((t.body.result as { recovery: string }).recovery, 'ok');
  const all = JSON.stringify(h.audits);
  assert.ok(!all.includes(rk) && !all.includes(rk.replace(/-/g, '')), 'no recovery key in the audit log');
  assert.ok(!all.includes('right-pw'), 'no password in the audit log');
  assert.deepEqual(h.audits.map((a) => a.action), ['encryption-keys.recovery-generate', 'encryption-keys.recovery-confirm', 'encryption-keys.recovery-confirm', 'encryption-keys.recovery-confirm', 'encryption-keys.rotate', 'encryption-keys.test-restore']);
  assert.ok(km.keyView().history.some((x) => x.actor === 'alice' && x.action === 'rotate.data-key'));
});

test('a refused switch (provider not available) is audited and changes nothing', async () => {
  await boot();
  const h = harness();
  const r = await runKeyOp(ctx, { op: 'switch', password: 'right-pw', provider: 'aws-kms', config: { keyArn: 'a', region: 'r' } }, h.deps);
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /not yet available/);
  assert.equal(km.keyView().provider.id, 'builtin');
  assert.equal(h.audits.at(-1)?.result, 'denied');
  assert.equal((await runKeyOp(ctx, { op: 'export-keys', password: 'right-pw' }, h.deps)).status, 400, 'there is no export operation');
});

test('the POST route takes a FATAL governance decision before any effect (GLUE-7)', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/platform-admin/encryption-keys/route.ts'), 'utf8');
  const post = src.slice(src.indexOf('export async function POST'));
  assert.ok(post.indexOf("authorize(`user:${user.id}`, 'admin')") > 0, 'authorize() is called');
  assert.ok(post.indexOf('if (!authz.allowed)') < post.indexOf('runKeyOp('), 'and refuses before runKeyOp');
});

test('details stay off the public /api/health; the in-cluster summary needs the service bearer; first-admin OPA race is handled', () => {
  const health = readFileSync(join(process.cwd(), 'app/api/health/route.ts'), 'utf8');
  assert.match(health, /connectionKeys: keys === 'ready' \? 'ok'/, 'only ok/degraded');
  assert.doesNotMatch(health, /connectionKeys: keyHealthSummary\(\),|provider:|recovery:/, 'no provider or recovery state on the unauthenticated endpoint');
  const route = readFileSync(join(process.cwd(), 'app/api/platform-admin/encryption-keys/route.ts'), 'utf8');
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
  assert.match(get, /searchParams\.get\('summary'\) === '1' && runtimeTokenOk\(req\.headers\.get\('authorization'\)\)/);
  assert.ok(get.indexOf('runtimeTokenOk') < get.indexOf('await adminCtx()'), 'without the bearer the admin gate applies');
  const post = route.slice(route.indexOf('export async function POST'));
  assert.ok(post.indexOf("authz.policy === 'opa-deny'") < post.indexOf('await recompile()') && post.indexOf('await recompile()') < post.indexOf('if (!authz.allowed) {'), 'recompile + ask again before refusing');
  assert.match(readFileSync(join(process.cwd(), 'tabs/admin/ui/EncryptionKeys.tsx'), 'utf8'), /has not confirmed your admin rights yet/);
});

test('Platform has an admin-only "Encryption keys" section', () => {
  const s = ADMIN_SECTIONS.find((x) => x.id === 'encryption-keys');
  assert.ok(s);
  assert.equal(s!.minRole, 'admin');
});

test('install wizard: the first-run admin goes from account setup to "Where should encryption keys live?"', () => {
  const root = join(process.cwd());
  const bootstrap = readFileSync(join(root, 'app/(entry)/onboarding/bootstrap/page.tsx'), 'utf8');
  assert.match(bootstrap, /window\.location\.href = invited \? '\/' : '\/onboarding\/encryption'/);
  const step = join(root, 'app/(entry)/onboarding/encryption/page.tsx');
  assert.ok(existsSync(step));
  const src = readFileSync(step, 'utf8');
  assert.match(src, /Where should encryption keys live\?/);
  assert.match(src, /RecoveryChoiceStep/);
  assert.match(readFileSync(join(root, 'tabs/admin/ui/EncryptionKeys.tsx'), 'utf8'), /export function RecoveryChoiceStep[\s\S]*<RecoveryKeyStep /, 'the "Recovery key" option is the existing flow');
  assert.match(src, /ProviderForm/);
  assert.match(readFileSync(join(root, 'core/ui/AuthGate.tsx'), 'utf8'), /\/onboarding\/encryption/);
});

test('ADMIN ONLY, server-side: any other role is refused (403 forbidden) before re-auth, audited, nothing changes', async () => {
  await boot();
  const h = harness();
  for (const role of ['creator', 'builder', 'domain_admin']) {
    const r = await runKeyOp({ user: { id: 'alice', role }, tenant: { id: 't1' } }, { op: 'recovery-none', password: 'right-pw', acknowledged: true }, h.deps);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'forbidden');
  }
  assert.equal(km.keyView().recoveryChoice.choice, 'unset', 'nothing changed');
  assert.ok(h.audits.every((a) => a.action === 'encryption-keys.recovery-none' && a.result === 'denied'));
});

test('"No recovery key": needs the password AND the acknowledgement; audited with who; no key material anywhere', async () => {
  await boot();
  const h = harness();
  let r = await runKeyOp(ctx, { op: 'recovery-none', acknowledged: true }, h.deps);
  assert.equal(r.status, 401, 're-authentication like every key change');
  r = await runKeyOp(ctx, { op: 'recovery-none', password: 'right-pw' }, h.deps);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'ack-required');
  assert.equal(km.keyView().recoveryChoice.choice, 'unset');
  r = await runKeyOp(ctx, { op: 'recovery-none', password: 'right-pw', acknowledged: true }, h.deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.hadRecoveryKey, false);
  assert.equal((r.body.view as km.KeyView).recoveryChoice.choice, 'none');
  assert.equal((r.body.view as km.KeyView).recoveryChoice.by, 'alice');
  const last = h.audits.at(-1)!;
  assert.equal(last.action, 'encryption-keys.recovery-none');
  assert.equal(last.result, 'ok');
  assert.match(last.detail, /no recovery key/);
  assert.ok(!JSON.stringify(h.audits).includes('right-pw'));
  assert.ok(!JSON.stringify(r.body).match(/[A-Z2-9]{5}-[A-Z2-9]{5}-/), 'no recovery key in the response');
});

test('recovery key → "none": the response says an exported copy existed (so the UI can point at rotation)', async () => {
  await boot();
  const h = harness();
  const g = await runKeyOp(ctx, { op: 'recovery-generate', password: 'right-pw' }, h.deps);
  await runKeyOp(ctx, { op: 'recovery-confirm', password: 'right-pw', saved: true, recoveryKey: g.body.recoveryKey }, h.deps);
  assert.equal(km.keyView().recoveryChoice.choice, 'recovery-key');
  const r = await runKeyOp(ctx, { op: 'recovery-none', password: 'right-pw', acknowledged: true }, h.deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.hadRecoveryKey, true);
  assert.equal(km.keyView().recovery.state, 'missing');
  assert.match(h.audits.at(-1)!.detail, /previous recovery key was removed/);
});

test('"Start over with new keys": acknowledgement required; refused (409) while the keys are not locked', async () => {
  await boot();
  const h = harness();
  let r = await runKeyOp(ctx, { op: 'reset-keys', password: 'right-pw' }, h.deps);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'ack-required');
  r = await runKeyOp(ctx, { op: 'reset-keys', password: 'right-pw', acknowledged: true }, h.deps);
  assert.equal(r.status, 409);
  assert.equal(h.audits.at(-1)?.result, 'denied');
  assert.equal(h.reloads(), 0);
});

test('"Start over" with a recovery key in the record: refused without the override; with it, a SEPARATE audit record', async () => {
  const store = memoryKeyStateStore();
  km.configureKeyManager({ store, env: ENV });
  await km.loadKeys();
  rateLimitReset('encryption-keys-reauth:alice');
  const h = harness();
  const g = await runKeyOp(ctx, { op: 'recovery-generate', password: 'right-pw' }, h.deps);
  await runKeyOp(ctx, { op: 'recovery-confirm', password: 'right-pw', saved: true, recoveryKey: g.body.recoveryKey }, h.deps);
  // The cluster's master key is lost.
  km.configureKeyManager({ store, env: { OS_SECRETS_ENCRYPTION_KEY: 'f'.repeat(20) + 'another-master-key-0123456789' } as NodeJS.ProcessEnv });
  await km.loadKeys();
  let r = await runKeyOp(ctx, { op: 'reset-keys', password: 'right-pw', acknowledged: true }, h.deps);
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /recovery key/);
  assert.ok(!h.audits.some((a) => a.action === 'encryption-keys.reset-keys.recovery-override'));
  r = await runKeyOp(ctx, { op: 'reset-keys', password: 'right-pw', acknowledged: true, overrideRecovery: true }, h.deps);
  assert.equal(r.status, 200);
  const override = h.audits.find((a) => a.action === 'encryption-keys.reset-keys.recovery-override');
  assert.ok(override && override.result === 'ok', 'the override is its own audit record');
  assert.equal(h.audits.at(-1)?.action, 'encryption-keys.reset-keys');
  assert.ok(!JSON.stringify(h.audits).includes(String(g.body.recoveryKey)));
});
