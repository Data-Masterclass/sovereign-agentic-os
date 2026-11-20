/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-30 EJECT TEST (design 11 A24 row d, AT-f) — a domain's committed guardrails decide
 *             in plain OPA with the platform policy and no OS present
 * USER STORY: As an engineer leaving the OS I want `opa eval` on my cloned domain repository and the
 *             platform's `guardrails.rego` to give the decisions the OS gives today.
 * ARCHITECTURE:
 *   - The repository comes from the REAL knowledge commit path (`commitKnowledge`), then a plain
 *     `git clone` with the git CLI; only `knowledge/workflows/<slug>/guardrails.json` and
 *     `charts/sovereign-agentic-os/policies/guardrails.rego` are mounted into the chart's pinned
 *     OPA image (values.yaml `opa.image`), loaded with OPA's own `<prefix>:<file>` syntax.
 *   - PARITY with today: every call is also decided by the per-workflow Rego the OS generates today
 *     (`compileGuardrails(...).rego` + its data), evaluated by the same OPA binary.
 *   - NEGATIVE TWINS: without the committed file every call is denied (`no_guardrails_loaded`), and
 *     a guardrails.json with one id removed changes the decision — the result reads the file.
 *   - Runs only with `WP50_EJECT=1` (CI job `artifacts-eject`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { commitKnowledge, __setKnowledgeGitForTests } from '@tabs/knowledge/lib/git/commit';
import { workflowRecord } from '@tabs/knowledge/lib/git/fixtures';
import { compileGuardrails } from '@tabs/knowledge/lib/guardrails';
import { parseWorkflow } from '@tabs/knowledge/lib/schema';

const ENABLED = process.env.WP50_EJECT === '1';
const SKIP = ENABLED ? false : 'set WP50_EJECT=1 to run plain OPA in its container (CI job artifacts-eject)';
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const POLICY = join(ROOT, 'charts', 'sovereign-agentic-os', 'policies', 'guardrails.rego');

function opaImage(): string {
  const v = yaml.load(readFileSync(join(ROOT, 'charts', 'sovereign-agentic-os', 'values.yaml'), 'utf8')) as { opa: { image: { repository: string; tag: string; digest: string } } };
  return `${v.opa.image.repository}:${v.opa.image.tag}@${v.opa.image.digest}`;
}

type Decision = { allow: boolean; reason: string; violated: string[]; guardrails: string[] };

function opaEval(mounts: Record<string, string>, data: string[], input: unknown, query: string): unknown {
  const dir = mkdtempSync(join(tmpdir(), 'wp30-eval-'));
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, 'input.json'), JSON.stringify(input));
  const v = Object.entries(mounts).flatMap(([host, ctr]) => ['-v', `${host}:${ctr}:ro`]);
  const r = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/in:ro`, ...v, opaImage(), 'eval', '-f', 'raw', ...data.flatMap((d) => ['-d', d]), '-i', '/in/input.json', query], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `opa eval: ${r.stderr}`);
  return r.stdout.trim() === '' ? undefined : JSON.parse(r.stdout);
}

/**
 * Today's decision: the per-workflow Rego module the OS generates, evaluated by the same OPA binary.
 *   - `live`: its data where the push path PUTs it (`<package path>/guardrails`) — what OPA decides today;
 *   - `intended`: its data where the generated Rego reads it (`data.guardrails`, an ABSOLUTE path).
 * The two differ: the generated Rego never sees the pushed data, so today every call is allowed,
 * even one that reports a violated guardrail. The platform policy keeps the intended semantics.
 */
function todayAllow(md: string, violations: string[], where: 'live' | 'intended'): boolean {
  const c = compileGuardrails(parseWorkflow(md));
  const dir = mkdtempSync(join(tmpdir(), 'wp30-today-'));
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, 'policy.rego'), c.rego);
  writeFileSync(join(dir, 'data.json'), JSON.stringify(c.data.guardrails));
  try {
    const prefix = where === 'live' ? `${c.packagePath}.guardrails` : 'guardrails';
    return opaEval({ [dir]: '/t' }, ['/t/policy.rego', `${prefix}:/t/data.json`], { violations }, `data.${c.packagePath}.allow`) === true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function clonedRepo(): Promise<{ work: string; clone: string; sha: string }> {
  const work = mkdtempSync(join(tmpdir(), 'wp30-eject-'));
  chmodSync(work, 0o755);
  const reposDir = join(work, 'repos');
  __setKnowledgeGitForTests(true);
  const res = await commitKnowledge('sales', { id: 'eject@example.com', name: 'Eject' }, { action: 'publish workflow' }, { reposDir, mirror: false, captured: { workflows: [workflowRecord()], manual: null } });
  __setKnowledgeGitForTests(null);
  assert.ok(res?.changed);
  const clone = join(work, 'clone');
  const src = join(reposDir, readdirSync(reposDir).find((d) => d.startsWith('sales'))!);
  const g = spawnSync('git', ['clone', '-q', src, clone], { encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  rmSync(join(clone, '.git'), { recursive: true, force: true }); // no OS, no git metadata: just files
  chmodSync(clone, 0o755);
  return { work, clone, sha: res!.sha };
}

const ID = 'wf_bank';
const FILE = 'knowledge/workflows/bank-submission/guardrails.json';
const CALLS = [[], ['wr2'], ['sr1'], ['wr2', 'sr1'], ['not_a_guardrail'], ['not_a_guardrail', 'sr1']];

function ejectDecision(clone: string, violations: string[], withFile = true): Decision {
  const data = ['/policy/guardrails.rego', ...(withFile ? [`os_data.guardrails.${ID}:/repo/${FILE}`] : [])];
  return opaEval({ [POLICY]: '/policy/guardrails.rego', [clone]: '/repo' }, data, { workflow_id: ID, violations }, 'data.os.guardrails.decision') as Decision;
}

test('EJECT: opa eval on the cloned repo + platform policy decides exactly as the OS decides today', { skip: SKIP, timeout: 600_000 }, async () => {
  const { work, clone, sha } = await clonedRepo();
  try {
    const md = workflowRecord().md;
    let diverged = 0;
    for (const violations of CALLS) {
      const d = ejectDecision(clone, violations);
      assert.deepEqual(d.guardrails, ['sr1', 'wr2']);
      assert.equal(d.allow, todayAllow(md, violations, 'intended'), `${JSON.stringify(violations)}: eject vs today's intended rule`);
      const live = todayAllow(md, violations, 'live');
      assert.equal(live, true, "today's pushed module allows every call (its data path is never read)");
      if (d.violated.length === 0) assert.equal(d.allow, live, `${JSON.stringify(violations)}: eject vs today's live decision`);
      else diverged++;
    }
    console.log(`[wp30-eject] opa eval (${opaImage().split('@')[0]}) on ${FILE} at ${sha.slice(0, 12)}: ${CALLS.length} calls = today's intended rule; ${CALLS.length - diverged} = today's live decision, ${diverged} differ (violations today's module never sees)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('EJECT NEGATIVE TWINS: no committed file denies every call; an edited file changes the decision', { skip: SKIP, timeout: 600_000 }, async () => {
  const { work, clone } = await clonedRepo();
  try {
    for (const violations of CALLS) {
      assert.deepEqual(ejectDecision(clone, violations, false), { allow: false, reason: 'no_guardrails_loaded', violated: [], guardrails: [] });
    }
    const path = join(clone, FILE);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { guardrails: { id: string }[] };
    writeFileSync(path, JSON.stringify({ guardrails: doc.guardrails.filter((g) => g.id !== 'sr1') }));
    const d = ejectDecision(clone, ['sr1']);
    assert.equal(d.allow, true, 'sr1 is no longer a guardrail of the edited file');
    assert.notEqual(d.allow, todayAllow(workflowRecord().md, ['sr1'], 'intended'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the eject policy is the file the chart loads (no second copy)', () => {
  assert.match(readFileSync(POLICY, 'utf8'), /^package os\.guardrails$/m);
  const tpl = readFileSync(join(ROOT, 'charts', 'sovereign-agentic-os', 'templates', 'base', 'opa', 'opa.yaml'), 'utf8');
  assert.match(tpl, /\.Files\.Get "policies\/guardrails\.rego"/);
});
