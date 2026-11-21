/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    The Rules panel's guardrail row is truthful offline
 * USER STORY: As a workflow owner I want "Guardrails enforced" only when OPA really enforces them.
 * ARCHITECTURE: OPA unreachable (nothing listens) → the row is a failure, never a tick. The real-OPA
 *   proof that a tick means a real deny is tests/opa/guardrails-push.int.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPA_URL = 'http://127.0.0.1:1';
const { applyGuardrails } = await import('@tabs/knowledge/lib/guardrails-apply');
const { compileGuardrails } = await import('@tabs/knowledge/lib/guardrails');
const { parseWorkflow } = await import('@tabs/knowledge/lib/schema');
const { WF_MD } = await import('@tabs/knowledge/lib/git/fixtures');

test('OPA unreachable: the row is not enforced, not applied, and says so', async () => {
  const r = await applyGuardrails(parseWorkflow(WF_MD));
  assert.equal(r.apply.status, 'fail');
  assert.equal(r.apply.applied, false);
  assert.equal(r.apply.verified, false);
  assert.match(r.apply.detail, /not enforced/i);
});

test('the generated module reads its own data path, never the document root', () => {
  const c = compileGuardrails(parseWorkflow(WF_MD));
  assert.ok(c.rego.includes(`data.${c.packagePath}.guardrails[_].id`));
  assert.ok(!/data\.guardrails\[/.test(c.rego));
});
