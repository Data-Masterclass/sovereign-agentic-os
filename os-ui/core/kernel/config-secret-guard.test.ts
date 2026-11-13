/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Boot-time FAIL-CLOSED guard (item 4/6): a production runtime must refuse to
 * start while signing sessions/MCP tokens with the shipped dev-default secret.
 * Keyed on NODE_ENV==='production' (NOT deploymentProfile — the live deploy runs
 * OS_PROFILE=local yet NODE_ENV=production, so a profile-keyed guard would be inert).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoDevDefaultSecretsInProd,
  runtimeBearerAuthAllowed,
  DEV_DEFAULT_SECRET,
  DEV_DEFAULT_AGENT_RUNTIME_TOKEN,
} from '@core/kernel/config';

const realNodeEnv = process.env.NODE_ENV;
const realPhase = process.env.NEXT_PHASE;
afterEach(() => {
  if (realNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = realNodeEnv;
  if (realPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = realPhase;
});

const REAL = 'a-real-strong-32+char-secret-value-xyz';

test('SECURITY: dev-default secret + NODE_ENV=production => THROWS at boot', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.NEXT_PHASE;
  assert.throws(
    () => assertNoDevDefaultSecretsInProd({ sessionSecret: DEV_DEFAULT_SECRET, mcpTokenSecret: REAL }),
    /OS_SESSION_SECRET/,
  );
  assert.throws(
    () => assertNoDevDefaultSecretsInProd({ sessionSecret: REAL, mcpTokenSecret: DEV_DEFAULT_SECRET }),
    /OS_MCP_TOKEN_SECRET/,
  );
  // Both offending → both named.
  assert.throws(
    () => assertNoDevDefaultSecretsInProd({ sessionSecret: DEV_DEFAULT_SECRET, mcpTokenSecret: DEV_DEFAULT_SECRET }),
    /OS_SESSION_SECRET.*OS_MCP_TOKEN_SECRET/s,
  );
});

test('a real secret in production => no throw', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.NEXT_PHASE;
  assert.doesNotThrow(() =>
    assertNoDevDefaultSecretsInProd({ sessionSecret: REAL, mcpTokenSecret: REAL }),
  );
});

test('dev-default secret + non-prod => no throw (local dev keeps working)', () => {
  process.env.NODE_ENV = 'development';
  assert.doesNotThrow(() =>
    assertNoDevDefaultSecretsInProd({ sessionSecret: DEV_DEFAULT_SECRET, mcpTokenSecret: DEV_DEFAULT_SECRET }),
  );
  delete process.env.NODE_ENV;
  assert.doesNotThrow(() =>
    assertNoDevDefaultSecretsInProd({ sessionSecret: DEV_DEFAULT_SECRET, mcpTokenSecret: DEV_DEFAULT_SECRET }),
  );
});

test('build phase (NEXT_PHASE=phase-production-build) => no throw even with dev-default', () => {
  process.env.NODE_ENV = 'production';
  process.env.NEXT_PHASE = 'phase-production-build';
  assert.doesNotThrow(() =>
    assertNoDevDefaultSecretsInProd({ sessionSecret: DEV_DEFAULT_SECRET, mcpTokenSecret: DEV_DEFAULT_SECRET }),
    'a secret-less CI build must still succeed; the guard fires at real boot',
  );
});

/**
 * Review B2-review-M3: the shared RUNTIME bearer grants un-narrowed, cross-domain reads
 * (`GET /api/data/projects` returns every domain's repository). The shipped placeholder is in this
 * repository, so under a production runtime it must be a closed door rather than a known key.
 */
test('runtimeBearerAuthAllowed: the shipped dev default is refused under a production runtime', () => {
  assert.equal(runtimeBearerAuthAllowed(DEV_DEFAULT_AGENT_RUNTIME_TOKEN, 'production'), false);
  assert.equal(runtimeBearerAuthAllowed('', 'production'), false);
  // A real configured token is honoured, production or not.
  assert.equal(runtimeBearerAuthAllowed('a-real-configured-value', 'production'), true);
  // Local dev (NODE_ENV!=='production') keeps the convenient default so clone-and-run works.
  assert.equal(runtimeBearerAuthAllowed(DEV_DEFAULT_AGENT_RUNTIME_TOKEN, 'development'), true);
  assert.equal(runtimeBearerAuthAllowed('', undefined), true);
});
