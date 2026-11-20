/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    No development defaults for Langfuse credentials in production config
 * USER STORY: As a security reviewer I want os-ui to carry no built-in Langfuse key or console
 *             login: a production boot without them stops with a typed error, and none of the
 *             development placeholders exists in the source or in a browser chunk.
 * ARCHITECTURE: the guard (`assertLangfuseCredentialsInProd`, keyed on NODE_ENV like the session
 *             secret guard), a source scan of os-ui, and — when a `next build` output is present —
 *             a scan of `.next/static`. The chart wiring is asserted by `scripts/check-worker-env.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLangfuseCredentialsInProd, MissingLangfuseCredentialError } from '@core/kernel/config';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PLACEHOLDERS = ['pk-lf-localdev', 'sk-lf-localdev', 'langfuse-local-dev-admin'];
const FULL = { langfusePublicKey: 'pk-x', langfuseSecretKey: 'sk-x', langfuseSsoEmail: 'a@b.c', langfuseSsoPassword: 'pw' };
const PROD = { nodeEnv: 'production', phase: '' };

test('production boot without a Langfuse key fails loudly with a typed error', () => {
  assert.throws(() => assertLangfuseCredentialsInProd({ ...FULL, langfuseSecretKey: '' }, PROD), (e: unknown) => {
    assert.ok(e instanceof MissingLangfuseCredentialError);
    assert.equal(e.code, 'missing_langfuse_credential');
    assert.deepEqual(e.missing, ['LANGFUSE_SECRET_KEY']);
    return true;
  });
  assert.throws(() => assertLangfuseCredentialsInProd({ langfusePublicKey: '', langfuseSecretKey: '', langfuseSsoEmail: '', langfuseSsoPassword: '' }, PROD), (e: unknown) => {
    assert.deepEqual((e as MissingLangfuseCredentialError).missing, ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_SSO_EMAIL', 'LANGFUSE_SSO_PASSWORD']);
    return true;
  });
});

test('the worker needs the project keys only; development and the build phase are not production boots', () => {
  assert.doesNotThrow(() => assertLangfuseCredentialsInProd({ ...FULL, langfuseSsoEmail: '', langfuseSsoPassword: '' }, { ...PROD, withSso: false }));
  assert.throws(() => assertLangfuseCredentialsInProd({ ...FULL, langfusePublicKey: '' }, { ...PROD, withSso: false }), MissingLangfuseCredentialError);
  assert.doesNotThrow(() => assertLangfuseCredentialsInProd({ ...FULL, langfuseSecretKey: '' }, { nodeEnv: 'development' }));
  assert.doesNotThrow(() => assertLangfuseCredentialsInProd({ ...FULL, langfuseSecretKey: '' }, { nodeEnv: 'production', phase: 'phase-production-build' }));
  assert.doesNotThrow(() => assertLangfuseCredentialsInProd(FULL, PROD));
});

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

test('no Langfuse development placeholder exists in os-ui source (so none can be bundled)', () => {
  const self = relative(ROOT, fileURLToPath(import.meta.url));
  const hits = files(ROOT)
    .filter((f) => relative(ROOT, f) !== self)
    .flatMap((f) => PLACEHOLDERS.filter((p) => readFileSync(f, 'utf8').includes(p)).map((p) => `${relative(ROOT, f)}: ${p}`));
  assert.deepEqual(hits, []);
});

test('a built client bundle carries no Langfuse placeholder (checked when .next/static exists)', (t) => {
  const dir = join(ROOT, '.next', 'static');
  if (!existsSync(dir)) return t.skip('no next build output here');
  const all: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.js')) all.push(p); } };
  walk(dir);
  const hits = all.flatMap((f) => PLACEHOLDERS.filter((p) => readFileSync(f, 'utf8').includes(p)).map((p) => `${relative(ROOT, f)}: ${p}`));
  assert.deepEqual(hits, []);
});
