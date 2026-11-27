/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents · knowledge · workflows
 * FEATURE:    i18n wave 4 — the agent-system, knowledge and workflow server messages a person reads carry a code
 * USER STORY: As a user who picked German I want "Not permitted to edit this system" or "This workflow change was
 *             refused by policy" in German, while API/MCP clients, logs and audit keep the same English.
 * ARCHITECTURE: Every coded reply in these areas must render, through the catalog, to EXACTLY the English the server
 *   sends, and exist in every language. The static ones are read straight out of the source (so a later wording
 *   change that forgets the catalog fails here); the dynamic ones are table-tested with their params, and the
 *   engine's typed errors and the pure knowledge editors are thrown for real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorBody, errorBodyOf, type ServerParams } from '@core/kernel/server-message';
import { assertServerEnglish } from '@core/testing/server-message';
import { RunNotVisibleError } from '@tabs/agents/lib/engine/run-visibility';
import { RunJobConflictError, RunJobNotFoundError } from '@tabs/agents/lib/engine/jobs';
import { RunInFlightError } from '@tabs/agents/lib/engine/run-lock';
import { ResumeNotFoundError, RunAlreadyFinishedError } from '@tabs/agents/lib/engine/run';
import { TooManyTailsError } from '@tabs/agents/lib/engine/tail-limit';
import { WHITELIST_HINT } from '@tabs/agents/lib/store';

const ROOT = process.cwd();
const FILES = [
  'tabs/agents/lib/store.ts',
  'tabs/knowledge/lib/store.ts',
  'tabs/knowledge/lib/personal-store.ts',
  'tabs/knowledge/lib/step-edit.ts',
  'tabs/knowledge/lib/rules-edit.ts',
  'app/api/agents/systems/route.ts',
  'app/api/agents/systems/[id]/route.ts',
  'app/api/agents/systems/[id]/assistant/route.ts',
  'app/api/agents/systems/[id]/schedule/route.ts',
  'app/api/agents/systems/[id]/folder/route.ts',
  'app/api/agents/systems/[id]/versions/route.ts',
  'app/api/agents/systems/[id]/evaluate/route.ts',
  'app/api/agents/systems/[id]/files/route.ts',
  'app/api/agents/systems/[id]/outputs/save/route.ts',
  'app/api/agents/systems/[id]/run/route.ts',
  'app/api/agents/systems/[id]/run/stream/route.ts',
  'app/api/agent/approvals/route.ts',
  'app/api/agent-chat/route.ts',
  'app/api/knowledge/personal/route.ts',
  'app/api/knowledge/personal/[id]/route.ts',
  'app/api/knowledge/personal/[id]/promote/route.ts',
  'app/api/knowledge/personal/[id]/folder/route.ts',
  'app/api/knowledge/personal/[id]/versions/route.ts',
  'app/api/knowledge/workflows/route.ts',
  'app/api/knowledge/workflows/[id]/route.ts',
  'app/api/knowledge/workflows/[id]/guardrails/route.ts',
  'app/api/knowledge/workflows/[id]/folder/route.ts',
  'app/api/knowledge/workflows/[id]/versions/route.ts',
  'app/api/knowledge/workflows/[id]/retrieve/route.ts',
  'app/api/knowledge/manual/[scope]/route.ts',
  'app/api/knowledge/manual/[scope]/versions/route.ts',
  'app/api/knowledge/domain/route.ts',
  'app/api/knowledge/domain/[domain]/versions/route.ts',
  'app/api/knowledge/docs/route.ts',
];

/** Every `apiError(<status>, '<english>', '<code>')`, `fail('<english>', <status>, '<code>')` and
 *  `withServerCode(new XError('<english>'), '<code>')` with a static English string. */
function staticPairs(src: string): { english: string; code: string }[] {
  const out: { english: string; code: string }[] = [];
  const S = String.raw`'((?:[^'\\]|\\.)*)'`;
  const res = [
    new RegExp(String.raw`apiError\(\s*[^,]+,\s*` + S + String.raw`,\s*'([a-z][\w.]+)'\s*\)`, 'g'),
    new RegExp(String.raw`\bfail\(` + S + String.raw`,\s*\d+,\s*'([a-z][\w.]+)'\)`, 'g'),
    new RegExp(String.raw`withServerCode\(new \w+\(` + S + String.raw`\),\s*'([a-z][\w.]+)'\)`, 'g'),
  ];
  for (const re of res) for (const m of src.matchAll(re)) out.push({ english: m[1].replace(/\\'/g, "'"), code: m[2] });
  return out;
}

test('every static coded English in the agents / knowledge / workflows sources renders exactly through the catalog', () => {
  let n = 0;
  for (const f of FILES) {
    const pairs = staticPairs(readFileSync(join(ROOT, f), 'utf8'));
    for (const { english, code } of pairs) {
      assertServerEnglish(errorBody(english, code));
      n += 1;
    }
  }
  assert.ok(n >= 80, `expected the scan to find the coded replies, found ${n}`);
});

const DYNAMIC: [string, string, ServerParams][] = [
  [`Path 'agents/x/notes.txt' is not editable — ${WHITELIST_HINT}`, 'agents.pathNotEditable', { path: 'agents/x/notes.txt' }],
  ["Agent 'writer' not found", 'agents.agentNotFound', { agent: 'writer' }],
  ['Version 12 not found', 'agents.versionNotFound', { version: '12' }],
  ['Version 1234 has no restorable source', 'agents.versionNotRestorable', { version: '1234' }],
  ['Version 3 not found', 'knowledge.versionNotFound', { version: '3' }],
  ['Version 3 has no restorable source', 'knowledge.versionNotRestorable', { version: '3' }],
  ['This system grants tool(s) with no governed MCP tool behind them: web_fetch, send_mail. Fix the grants in system.yaml, then run again.', 'agents.unmappedGrants', { tools: 'web_fetch, send_mail' }],
  ['Already approved', 'agents.alreadyDecided', { status: 'approved' }],
  ['Already withdrawn', 'agents.alreadyDecided', { status: 'withdrawn' }],
  ['This item needs a Builder of finance', 'agents.itemNeedsRole', { role: 'Builder', domain: 'finance' }],
  ['This workflow change was refused by policy (workflow.update) — the policy engine did not allow it, or did not answer. Nothing was changed.', 'workflows.policyRefused', { op: 'workflow.update' }],
  ['Applying guardrails was refused by policy (workflow.guardrails) — the policy engine did not allow it, or did not answer. Nothing was changed.', 'workflows.guardrailsPolicyRefused', { op: 'workflow.guardrails' }],
  ["Step 's3' is not in this workflow", 'workflows.stepNotFound', { step: 's3' }],
  ["Actor 'a1' is not in this workflow", 'workflows.actorNotFound', { actor: 'a1' }],
  ["Another actor is already named 'Clerk' (Human)", 'workflows.actorNameTaken', { name: 'Clerk', category: 'Human' }],
  ["Workflow rule 'r9' not found", 'workflows.ruleNotFound', { rule: 'r9' }],
];

test('the dynamic agents / knowledge / workflows messages render exactly with their params', () => {
  for (const [english, code, params] of DYNAMIC) assertServerEnglish(errorBody(english, code, params));
});

test("the engine's typed run errors keep their English and carry a code the envelope forwards", () => {
  const errors: Error[] = [
    new RunNotVisibleError('run_abc'),
    new RunJobNotFoundError('run_abc'),
    new RunJobConflictError('run_abc', 'running'),
    new RunJobConflictError('run_abc', 'queued'),
    new RunInFlightError('run_abc'),
    new ResumeNotFoundError('run_abc'),
    new RunAlreadyFinishedError('run_abc'),
    new TooManyTailsError(64),
  ];
  for (const e of errors) {
    const body = errorBodyOf(e);
    assert.equal(body.error, e.message, 'the English is unchanged');
    assertServerEnglish(body);
  }
  // Status codes are untouched.
  assert.equal((new RunNotVisibleError('x') as unknown as { status: number }).status, 404);
  assert.equal((new RunJobConflictError('x', 'running') as unknown as { status: number }).status, 409);
});
