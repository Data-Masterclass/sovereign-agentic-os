/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Refuse development secret defaults in production (defence in depth)
 * USER STORY: As an operator I want os-ui and the run worker to refuse a production boot when a
 *             secret is missing or equals its public development default — one test per secret,
 *             each with its twin (a real value boots).
 * ARCHITECTURE:
 *   - Drives `assertProductionSecrets` with synthetic environments; the digests are pinned to the
 *     literals in dev-secret-defaults.ts and values.yaml, and to the deploy preflight's table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertProductionSecrets,
  findSecretProblems,
  isPublicDefault,
  InsecureProductionSecretError,
  PUBLIC_DEFAULT_SHA256,
} from '@core/kernel/secret-guard';
import { DEV_SECRET_DEFAULTS } from '@core/kernel/dev-secret-defaults';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A strong, unique value per variable (what a correctly configured install has). */
const real = (name: string) => `real-${name.toLowerCase()}-${'x'.repeat(24)}`;
// AGENT_KEY_ENCRYPTION_KEY has no public default (no code fallback, the chart generates it): it is guarded for 'missing'.
const UI_SECRETS = ['LITELLM_MASTER_KEY', 'AGENT_RUNTIME_TOKEN', 'OS_SESSION_SECRET', 'OS_MCP_TOKEN_SECRET', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_SSO_PASSWORD', 'AGENT_KEY_ENCRYPTION_KEY'];
const WORKER_SECRETS = ['AGENT_RUNTIME_TOKEN', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'AGENT_KEY_ENCRYPTION_KEY'];
const prodEnv = (names: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ NODE_ENV: 'production', ...Object.fromEntries(names.map((n) => [n, real(n)])), ...extra }) as NodeJS.ProcessEnv;

/** The public default each variable can carry: code fallbacks AND the chart's values.yaml. */
const valuesYaml = readFileSync(resolve(repo, 'charts/sovereign-agentic-os/values.yaml'), 'utf8');
const yamlLiteral = (re: RegExp) => {
  const m = valuesYaml.match(re);
  assert.ok(m, `values.yaml literal not found: ${re}`);
  return m[1];
};
const DEFAULTS: Record<string, string[]> = {
  LITELLM_MASTER_KEY: [DEV_SECRET_DEFAULTS.litellmMasterKey, yamlLiteral(/^litellmMasterKey: "([^"]+)"/m)],
  AGENT_RUNTIME_TOKEN: [DEV_SECRET_DEFAULTS.agentRuntimeToken, yamlLiteral(/^agentRuntime:\n {2}token: "([^"]+)"/m)],
  OS_SESSION_SECRET: [DEV_SECRET_DEFAULTS.sessionSecret],
  OS_MCP_TOKEN_SECRET: [DEV_SECRET_DEFAULTS.sessionSecret],
  TERMINAL_BROKER_SECRET: [DEV_SECRET_DEFAULTS.terminalBrokerSecret],
  LANGFUSE_PUBLIC_KEY: [yamlLiteral(/^langfuseInit:\n {2}publicKey: "([^"]+)"/m)],
  LANGFUSE_SSO_PASSWORD: [yamlLiteral(/^langfuseInit:\n(?: {2}.*\n)*? {2}userPassword: "([^"]+)"/m)],
  LANGFUSE_SECRET_KEY: [yamlLiteral(/^langfuseInit:\n(?: {2}.*\n)*? {2}secretKey: "([^"]+)"/m)],
};

test('the digest table covers exactly the published defaults (code fallbacks and values.yaml)', () => {
  for (const [name, literals] of Object.entries(DEFAULTS)) {
    const want = [...new Set(literals.map(sha))].sort();
    assert.deepEqual([...(PUBLIC_DEFAULT_SHA256[name] ?? [])].sort(), want, `${name}: digests drifted from the published defaults`);
  }
  assert.deepEqual(Object.keys(PUBLIC_DEFAULT_SHA256).sort(), Object.keys(DEFAULTS).sort());
});

test('the deploy preflight carries the same digests as the boot guard', () => {
  const py = readFileSync(resolve(repo, 'scripts/lib/check-secrets-not-defaults.py'), 'utf8');
  for (const [name, digests] of Object.entries(PUBLIC_DEFAULT_SHA256)) {
    for (const d of digests) assert.ok(py.includes(`'${d}'`), `check-secrets-not-defaults.py lacks the ${name} digest ${d.slice(0, 8)}…`);
  }
  const pyDigests = [...py.matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);
  const tsDigests = new Set(Object.values(PUBLIC_DEFAULT_SHA256).flat());
  for (const d of pyDigests) assert.ok(tsDigests.has(d), `check-secrets-not-defaults.py has a digest the boot guard does not: ${d.slice(0, 8)}…`);
});

test('a correctly configured production os-ui and worker boot (the twin of every refusal below)', () => {
  assert.doesNotThrow(() => assertProductionSecrets('os-ui', prodEnv(UI_SECRETS)));
  assert.doesNotThrow(() => assertProductionSecrets('os-ui-worker', prodEnv(WORKER_SECRETS)));
});

for (const name of UI_SECRETS) {
  test(`os-ui refuses a production boot when ${name} equals a public default, and when it is missing`, () => {
    for (const literal of DEFAULTS[name] ?? []) {
      const env = prodEnv(UI_SECRETS, { [name]: literal });
      assert.throws(() => assertProductionSecrets('os-ui', env), (err: unknown) => {
        assert.ok(err instanceof InsecureProductionSecretError);
        assert.deepEqual(err.problems, [{ name, reason: 'public-default' }]);
        assert.ok(!err.message.includes(literal), 'the message must never carry the value');
        return true;
      });
    }
    const env = prodEnv(UI_SECRETS);
    delete env[name];
    if (name === 'OS_MCP_TOKEN_SECRET') {
      // Unset falls back to the session secret, exactly as config.ts does: not missing.
      assert.doesNotThrow(() => assertProductionSecrets('os-ui', env));
      env.OS_SESSION_SECRET = DEV_SECRET_DEFAULTS.sessionSecret;
      assert.deepEqual(findSecretProblems('os-ui', env).map((p) => p.name), ['OS_SESSION_SECRET', 'OS_MCP_TOKEN_SECRET']);
    } else {
      assert.throws(() => assertProductionSecrets('os-ui', env), new RegExp(`${name} \\(missing\\)`));
    }
  });
}

test('os-ui guards TERMINAL_BROKER_SECRET only when the terminal is enabled', () => {
  const off = prodEnv(UI_SECRETS);
  assert.doesNotThrow(() => assertProductionSecrets('os-ui', off), 'nothing reads the broker secret while the terminal is off');
  assert.throws(() => assertProductionSecrets('os-ui', { ...off, TERMINAL_ENABLED: 'true' }), /TERMINAL_BROKER_SECRET \(missing\)/);
  assert.throws(
    () => assertProductionSecrets('os-ui', { ...off, TERMINAL_ENABLED: 'true', TERMINAL_BROKER_SECRET: DEV_SECRET_DEFAULTS.terminalBrokerSecret }),
    /TERMINAL_BROKER_SECRET \(equals a public development default\)/,
  );
  assert.doesNotThrow(() => assertProductionSecrets('os-ui', { ...off, TERMINAL_ENABLED: 'true', TERMINAL_BROKER_SECRET: real('TERMINAL_BROKER_SECRET') }));
});

for (const name of WORKER_SECRETS) {
  test(`the worker refuses a production boot when ${name} equals a public default, and when it is missing`, () => {
    for (const literal of DEFAULTS[name] ?? []) {
      assert.throws(() => assertProductionSecrets('os-ui-worker', prodEnv(WORKER_SECRETS, { [name]: literal })), new RegExp(`${name} \\(equals`));
    }
    const env = prodEnv(WORKER_SECRETS);
    delete env[name];
    assert.throws(() => assertProductionSecrets('os-ui-worker', env), new RegExp(`${name} \\(missing\\)`));
  });
}

test('the worker is never asked for an admin secret its pod does not carry', () => {
  assert.doesNotThrow(() => assertProductionSecrets('os-ui-worker', prodEnv(WORKER_SECRETS)));
  const names = findSecretProblems('os-ui-worker', { NODE_ENV: 'production' } as NodeJS.ProcessEnv).map((p) => p.name);
  for (const admin of ['LITELLM_MASTER_KEY', 'OS_SESSION_SECRET', 'OS_MCP_TOKEN_SECRET', 'TERMINAL_BROKER_SECRET']) assert.ok(!names.includes(admin), admin);
});

test('development and `next build` are not guarded', () => {
  const env = { LITELLM_MASTER_KEY: DEV_SECRET_DEFAULTS.litellmMasterKey } as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => assertProductionSecrets('os-ui', { ...env, NODE_ENV: 'development' }));
  assert.doesNotThrow(() => assertProductionSecrets('os-ui', { ...env, NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }));
});

test('a laptop install (chart marker) accepts chart defaults with a warning, but never a missing secret or the session secret', () => {
  const warnings: string[] = [];
  const laptop = prodEnv(UI_SECRETS, {
    OS_ALLOW_PUBLIC_DEV_SECRETS: 'laptop',
    LITELLM_MASTER_KEY: DEV_SECRET_DEFAULTS.litellmMasterKey,
    LANGFUSE_SECRET_KEY: DEFAULTS.LANGFUSE_SECRET_KEY[0],
  });
  assert.doesNotThrow(() => assertProductionSecrets('os-ui', laptop, (m) => warnings.push(m)));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => !w.includes(DEV_SECRET_DEFAULTS.litellmMasterKey) && !w.includes(DEFAULTS.LANGFUSE_SECRET_KEY[0])));
  assert.throws(() => assertProductionSecrets('os-ui', { ...laptop, OS_SESSION_SECRET: DEV_SECRET_DEFAULTS.sessionSecret }, () => {}), /OS_SESSION_SECRET/);
  const missing = { ...laptop };
  delete missing.AGENT_RUNTIME_TOKEN;
  assert.throws(() => assertProductionSecrets('os-ui', missing, () => {}), /AGENT_RUNTIME_TOKEN \(missing\)/);
  // Any other marker value is no marker.
  assert.throws(() => assertProductionSecrets('os-ui', { ...laptop, OS_ALLOW_PUBLIC_DEV_SECRETS: 'true' }), /LITELLM_MASTER_KEY/);
});

test('isPublicDefault compares by digest only: near misses and other variables are not defaults', () => {
  assert.equal(isPublicDefault('LITELLM_MASTER_KEY', DEV_SECRET_DEFAULTS.litellmMasterKey), true);
  assert.equal(isPublicDefault('LITELLM_MASTER_KEY', `${DEV_SECRET_DEFAULTS.litellmMasterKey} `), false);
  assert.equal(isPublicDefault('LITELLM_MASTER_KEY', DEV_SECRET_DEFAULTS.sessionSecret), false);
  assert.equal(isPublicDefault('UNKNOWN', DEV_SECRET_DEFAULTS.litellmMasterKey), false);
});

test('the guard is wired into both boots', () => {
  const ui = readFileSync(resolve(here, '../../instrumentation.ts'), 'utf8');
  assert.match(ui, /assertProductionSecrets\('os-ui'\)/);
  const worker = readFileSync(resolve(here, '../../worker/agent-runs.ts'), 'utf8');
  assert.match(worker, /assertProductionSecrets\('os-ui-worker'\)/);
  // The secret guard module holds digests, not the literals.
  const guard = readFileSync(resolve(here, 'secret-guard.ts'), 'utf8');
  for (const v of Object.values(DEV_SECRET_DEFAULTS)) assert.ok(!guard.includes(v), 'secret-guard.ts must not spell out a default');
});
