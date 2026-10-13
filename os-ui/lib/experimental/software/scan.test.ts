/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityScan } from './scan.ts';

test('clean repo passes the security scan', () => {
  const r = securityScan([
    { path: 'package.json', content: JSON.stringify({ dependencies: { next: '^15.0.0' } }) },
    { path: 'src/index.ts', content: 'export const ok = 1;\n' },
  ]);
  assert.equal(r.passed, true);
  assert.equal(r.findings.length, 0);
});

test('a committed secret BLOCKS the deploy (critical, secrets category)', () => {
  const r = securityScan([
    { path: 'config.ts', content: 'const key = "AKIAIOSFODNN7EXAMPLE";\n' },
  ]);
  assert.equal(r.passed, false);
  assert.equal(r.summary.secrets >= 1, true);
  assert.equal(r.findings.some((f) => f.severity === 'critical'), true);
});

test('eval() is a high SAST finding and blocks', () => {
  const r = securityScan([{ path: 'a.ts', content: 'eval(userInput)\n' }]);
  assert.equal(r.passed, false);
  assert.equal(r.findings.some((f) => f.category === 'sast' && f.severity === 'high'), true);
});

test('a known-vulnerable dependency blocks', () => {
  const r = securityScan([
    { path: 'package.json', content: JSON.stringify({ dependencies: { lodash: '4.17.20' } }) },
  ]);
  assert.equal(r.passed, false);
  assert.equal(r.summary.deps >= 1, true);
});

test('a hardcoded URL in source is a low (non-blocking) finding', () => {
  const r = securityScan([{ path: 'a.ts', content: 'fetch("https://api.example.com")\n' }]);
  assert.equal(r.passed, true); // low does not block
  assert.equal(r.findings.some((f) => f.severity === 'low'), true);
});
