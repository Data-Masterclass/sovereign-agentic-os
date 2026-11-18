/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    NODE_ENV=production + the flag unset ⇒ the security scan grants no green tick
 * USER STORY: As an approver of a software deploy I must never be handed `passed: true` from a
 *             scanner that never ran. The gap report filed it: `scan.mode` was a DEFAULT
 *             PARAMETER, always `offline-mock`, and `decideDeploy` approves only on
 *             `card.scan.passed` — so the gate was green by construction on the cluster.
 * ARCHITECTURE:
 *   - The real findings the deterministic baseline produces are REAL (it greps the real committed
 *     files) and are still reported — they are evidence of actual problems. What is refused is the
 *     VERDICT: with no scanner engine, `passed` is false, `mode` is `unavailable` and `reason`
 *     says why. Blocking is the fail-closed answer; `seeded-evidence.ts` makes the same choice.
 *   - `securityScan` is pure, so this drives it directly — no app, no runner, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityScan } from '@tabs/software/lib/scan';
import { OFFLINE_MOCK_ENV } from '@core/kernel/offline-mock';
import type { ScaffoldFile } from '@tabs/software/lib/model';

/** A clean tree: nothing for the baseline scanner to find, so `passed` turns on the ENGINE alone. */
const CLEAN: ScaffoldFile[] = [
  { path: 'package.json', content: '{"name":"app","dependencies":{"react":"19.0.0"}}' },
  { path: 'src/index.ts', content: 'export const hello = () => "hi";\n' },
];

/** A tree with a committed AWS key — a real finding the baseline really does catch. */
const DIRTY: ScaffoldFile[] = [
  { path: 'package.json', content: '{"name":"app"}' },
  { path: 'src/aws.ts', content: 'const id = "AKIAIOSFODNN7EXAMPLE";\nexport default id;\n' },
];

function withEnv<T>(nodeEnv: string, flag: string | undefined, body: () => T): T {
  const prevNode = process.env.NODE_ENV;
  const prevFlag = process.env[OFFLINE_MOCK_ENV];
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  if (flag === undefined) delete process.env[OFFLINE_MOCK_ENV];
  else process.env[OFFLINE_MOCK_ENV] = flag;
  try {
    return body();
  } finally {
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = prevNode;
    if (prevFlag === undefined) delete process.env[OFFLINE_MOCK_ENV];
    else process.env[OFFLINE_MOCK_ENV] = prevFlag;
  }
}

test('PRODUCTION + flag unset + no live scanner ⇒ NO passing verdict (the gate closes)', () => {
  const r = withEnv('production', undefined, () => securityScan(CLEAN));
  assert.equal(r.passed, false, 'a clean tree is not a passed scan when nothing scanned it');
  assert.equal(r.mode, 'unavailable');
  assert.equal(r.unavailable, true);
  assert.match(r.reason ?? '', /scanner/i, 'says WHY there is no verdict');
  assert.equal(r.mode === 'offline-mock', false, 'the misleading label is gone, not re-used');
});

test('PRODUCTION: the REAL findings are still reported — refusing a verdict is not hiding evidence', () => {
  const r = withEnv('production', undefined, () => securityScan(DIRTY));
  assert.equal(r.passed, false);
  assert.equal(r.summary.secrets, 1, 'the committed AWS key is still named');
  assert.ok(r.findings.some((f) => f.category === 'secrets'), 'the finding survives the refusal');
});

test('PRODUCTION + an injected LIVE scanner passes normally — the gate is about the engine, not the mode', () => {
  const r = withEnv('production', undefined, () => securityScan(CLEAN, 'live'));
  assert.equal(r.mode, 'live');
  assert.equal(r.passed, true, 'a real scanner on a clean tree passes');
  assert.equal('unavailable' in r, false);
});

test('PRODUCTION + a typo on the switch still refuses the verdict', () => {
  for (const typo of ['true', 'yes', 'ALLOW']) {
    const r = withEnv('production', typo, () => securityScan(CLEAN));
    assert.equal(r.passed, false, `${typo} must not grant a verdict`);
  }
});

test('a laptop keeps the demonstrable offline gate — byte-identical to before', () => {
  const clean = withEnv('development', undefined, () => securityScan(CLEAN));
  assert.equal(clean.mode, 'offline-mock');
  assert.equal(clean.passed, true, 'the teaching flow still shows a green gate it can then fail');
  const dirty = withEnv('development', undefined, () => securityScan(DIRTY));
  assert.equal(dirty.mode, 'offline-mock');
  assert.equal(dirty.passed, false, 'and a leaked secret still blocks, as the lesson requires');
});

test('an explicit `allow` in production is the deliberate opt-in, and it is labelled', () => {
  const r = withEnv('production', 'allow', () => securityScan(CLEAN));
  assert.equal(r.mode, 'offline-mock');
  assert.equal(r.passed, true);
});
