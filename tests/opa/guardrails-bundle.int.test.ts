/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * guardrails-bundle.int.test — WP-30 (design 04 M7, 11 A24) on two REAL OPA 1.22.4 containers
 * started from the chart:
 *   A  today's path (chart default): os-ui PUTs one generated Rego module + its data per workflow
 *      (`applyGuardrails`, `PUT /v1/policies/knowledge-<id>`);
 *   B  `opa.dataBundle.enabled=true` + `opa.guardrailsData.enabled=true`: the platform policy
 *      `os.guardrails` is a chart file, and the guardrail DATA is the committed
 *      `knowledge/workflows/<slug>/guardrails.json` of each domain repository, which os-ui compiles
 *      into the os-data bundle that OPA downloads.
 * Asserted:
 *   - PARITY: for every fixture workflow × call (no violation, each guardrail, all, a foreign id),
 *     B's `os.guardrails.decision.allow` equals A's generated `allow` for every call that reports no
 *     violated guardrail. For a call that does, today's module allows (it reads `data.guardrails`,
 *     an absolute path, never the path it is PUT at) and B denies; the test asserts both sides;
 *   - EJECT: `opa eval` in the chart's OPA image, on a plain `git clone` of the domain repo with the
 *     platform `guardrails.rego`, returns B's decision for every call;
 *   - B has no runtime-uploaded policy module (`GET /v1/policies`);
 *   - os-ui's `decideGuardrails` asks B and gets the same decision; an unreachable OPA denies.
 * NEGATIVE TWIN: the hard rules are removed in git → B denies (`no_guardrails_loaded`) while A, which
 * holds a runtime upload, still allows — B decides from git, not from os-ui's memory.
 *
 * Run (from os-ui/, docker + helm + git + python3 with pyyaml):
 *   node --experimental-test-module-mocks --import ./scripts/test-setup.mjs --test ../tests/opa/guardrails-bundle.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { Opa, TOKEN, chartEnv, docker, fakeEmptyMirror, startBundleServer, startChartOpa, until, type BundleServer } from './bundle-it.ts';
import { seedOsState } from './fixture.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT_A = Number(process.env.OPA_IT_PUSH_PORT ?? 18194);
const PORT_B = Number(process.env.OPA_IT_BUNDLE_PORT ?? 18195);
const SERVER_PORT = Number(process.env.OPA_IT_SERVER_PORT ?? 18284);
const A = new Opa(`http://127.0.0.1:${PORT_A}`);
const B = new Opa(`http://127.0.0.1:${PORT_B}`);
const B_SETS = ['opa.dataBundle.enabled=true', 'opa.guardrailsData.enabled=true', `opa.dataBundle.serviceUrl=http://host.docker.internal:${SERVER_PORT}/api/opa`];
const WORK = mkdtempSync(join(process.env.OPA_IT_DIR ?? tmpdir(), 'wp30-it-'));
chmodSync(WORK, 0o755);

process.env.OPA_URL = A.url; // today's push path writes into A
process.env.OS_OPA_BUNDLE_TOKEN = TOKEN;
process.env.AGENT_RUNTIME_TOKEN = 'a-different-shared-runtime-token';
process.env.OS_OPA_DATA_BUNDLE = '1';
process.env.OS_GUARDRAILS_DATA = chartEnv('OS_GUARDRAILS_DATA', B_SETS.slice(0, 2));
process.env.OS_OPA_SEED = chartEnv('OS_OPA_SEED', ['opa.dataBundle.enabled=true']);
process.env.OS_OPA_SEED_PRINCIPALS = chartEnv('OS_OPA_SEED_PRINCIPALS');
process.env.OS_REPOS_DIR = join(WORK, 'repos');
process.env.DATA_PROJECT_GIT = 'true';
await fakeEmptyMirror();

const values = yaml.load(readFileSync(join(ROOT, 'charts/sovereign-agentic-os/values.yaml'), 'utf8')) as { opa: { image: { repository: string; tag: string; digest: string } } };
const OPA_IMAGE = `${values.opa.image.repository}:${values.opa.image.tag}@${values.opa.image.digest}`;

const REFUND_MD = `---
id: wf_refund
title: Refund Approval
domain: sales
visibility: Shared
status: live
version: "1"
rules:
  - {id: r_limit, text: "Refunds above 500 EUR need a second approver", hard: true, scope: workflow}
  - {id: r_tone, text: "Be friendly", hard: false, scope: workflow}
actors: []
---

Approve or reject a refund request.

\`\`\`step
id: check
title: Check
actor: Agent
rules:
  - {id: c_kyc, text: "The customer passed KYC", hard: true}
  - {id: c_dup, text: "No duplicate refund in 30 days", hard: true}
\`\`\`
`;

let server: BundleServer;
before(async () => {
  startChartOpa('wp30-push', PORT_A, []);
  startChartOpa('wp30-bundle', PORT_B, B_SETS);
  await until(() => A.status('/health'), (s) => s === 200, 60_000);
  server = await startBundleServer(SERVER_PORT);
});
after(async () => {
  await server?.close();
  docker('rm', '-f', 'wp30-push', 'wp30-bundle');
  rmSync(WORK, { recursive: true, force: true });
});

type Decision = { allow: boolean; reason: string; violated: string[]; guardrails: string[] };

function calls(ids: string[]): string[][] {
  return [[], ...ids.map((i) => [i]), ids, ['not_a_guardrail'], ['not_a_guardrail', ids[0]]];
}

async function commit(records: unknown[]) {
  const { commitKnowledge } = await import('@tabs/knowledge/lib/git/commit');
  const r = await commitKnowledge('sales', { id: 'alex@example.com', name: 'Alex' }, { action: 'publish workflow' }, { mirror: false, captured: { workflows: records as never, manual: null } });
  assert.ok(r?.changed, 'the knowledge commit wrote the domain repo');
  return r!.sha;
}

async function activeOn(o: Opa, workflowId: string, want: (d: Decision | undefined) => boolean): Promise<Decision | undefined> {
  const { recompileOsData } = await import('@core/policy/bundle');
  const r = await recompileOsData('wp30-it');
  assert.ok(r.ok, r.ok ? '' : r.detail);
  return until(() => o.eval('os/guardrails/decision', { workflow_id: workflowId, violations: [] }) as Promise<Decision>, want, 60_000, 250);
}

/** `opa eval` on a plain git clone: the platform policy + the committed file, nothing else. */
function ejectDecision(clone: string, workflowId: string, slug: string, violations: string[]): Decision {
  const dir = mkdtempSync(join(WORK, 'eval-'));
  chmodSync(dir, 0o755);
  copyFileSync(join(ROOT, 'charts/sovereign-agentic-os/policies/guardrails.rego'), join(dir, 'guardrails.rego'));
  writeFileSync(join(dir, 'call.json'), JSON.stringify({ workflow_id: workflowId, violations }));
  const args = ['run', '--rm', '-v', `${dir}:/p:ro`, '-v', `${clone}:/repo:ro`, OPA_IMAGE, 'eval', '-f', 'raw', '-d', '/p/guardrails.rego'];
  const file = join(clone, 'knowledge/workflows', slug, 'guardrails.json');
  if (existsSync(file)) args.push('-d', `os_data.guardrails.${workflowId}:/repo/knowledge/workflows/${slug}/guardrails.json`);
  args.push('-i', '/p/call.json', 'data.os.guardrails.decision');
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Decision;
}

test('parity with today, eject equals the OS, no runtime policy module, and git is the source', { timeout: 600_000 }, async () => {
  await seedOsState({ users: 12, tables: 3 });
  const { workflowRecord } = await import('@tabs/knowledge/lib/git/fixtures');
  const { parseWorkflow } = await import('@tabs/knowledge/lib/schema');
  const { applyGuardrails } = await import('@tabs/knowledge/lib/guardrails-apply');
  const { compileGuardrails } = await import('@tabs/knowledge/lib/guardrails');
  const { decideGuardrails } = await import('@tabs/knowledge/lib/guardrails-data');
  const bank = workflowRecord();
  const refund = workflowRecord({ id: 'wf_refund', title: 'Refund Approval', md: REFUND_MD, tacit: '' });
  const sha = await commit([bank, refund]);

  // A: today's path, the generated module per workflow.
  for (const r of [bank, refund]) {
    const res = await applyGuardrails(parseWorkflow(r.md));
    assert.equal(res.apply.status, 'ok', res.apply.detail);
  }
  const ready = await until(() => B.status(), (s) => s === 200, 60_000);
  assert.equal(ready, 200, 'bundle-mode OPA activated os-data');

  const clone = join(WORK, 'clone');
  const g = spawnSync('git', ['clone', '-q', join(process.env.OS_REPOS_DIR!, readdirSync(process.env.OS_REPOS_DIR!).find((d) => d.startsWith('sales'))!), clone], { encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), sha, 'the clone is the committed sha');
  rmSync(join(clone, '.git'), { recursive: true, force: true });

  let n = 0;
  let same = 0;
  let differ = 0;
  for (const [r, slug] of [[bank, 'bank-submission'], [refund, 'refund-approval']] as const) {
    const compiled = compileGuardrails(parseWorkflow(r.md));
    const ids = compiled.guardrails.map((x) => x.id);
    await activeOn(B, r.id, (d) => (d?.guardrails.length ?? 0) === new Set(ids).size);
    for (const violations of calls(ids)) {
      const today = (await A.eval(`${compiled.packagePath.replace(/\./g, '/')}/allow`, { violations })) === true;
      const os = (await B.eval('os/guardrails/decision', { workflow_id: r.id, violations })) as Decision;
      if (os.violated.length === 0) {
        assert.equal(os.allow, today, `${r.id} ${JSON.stringify(violations)}: bundle ${os.allow} vs today ${today}`);
        same++;
      } else {
        // Today's generated module reads data.guardrails (absolute), not the path it is PUT at, so
        // it allows a call that reports a violated guardrail. The platform policy denies it.
        assert.equal(today, true, 'today allows a reported violation (the defect)');
        assert.equal(os.allow, false, 'the platform policy denies a reported violation');
        differ++;
      }
      assert.deepEqual(ejectDecision(clone, r.id, slug, violations), os, `${r.id} ${JSON.stringify(violations)}: eject = OS`);
      assert.deepEqual(await decideGuardrails(r.id, violations, { opaUrl: B.url }), os, 'os-ui asks OPA and relays its decision');
      n++;
    }
  }
  console.log(`[wp30] ${n} calls over 2 workflows at ${sha.slice(0, 12)}: eject = OS for all ${n}; today = OS for ${same}; ${differ} differ (a reported violation: today allows, the platform policy denies)`);

  const policies = ((await (await fetch(`${B.url}/v1/policies`)).json()) as { result: { id: string }[] }).result.map((p) => p.id);
  assert.ok(policies.some((p) => p.endsWith('guardrails.rego')), `the platform policy is loaded from the chart: ${policies.join(', ')}`);
  assert.ok(!policies.some((p) => p.startsWith('knowledge-')), `no runtime-uploaded module on B: ${policies.join(', ')}`);

  // NEGATIVE TWIN: remove the hard rules in git. B follows git; A keeps its runtime upload.
  const soft = bank.md.replace(/hard: true/g, 'hard: false');
  await commit([{ ...bank, md: soft }, refund]);
  const after = await activeOn(B, bank.id, (d) => d?.reason === 'no_guardrails_loaded');
  assert.deepEqual(after, { allow: false, reason: 'no_guardrails_loaded', violated: [], guardrails: [] });
  assert.equal(await A.eval('agentic/knowledge/wf_bank/allow', { violations: [] }), true, 'A still holds the stale runtime module');

  // Fail closed: an unreachable OPA denies.
  assert.deepEqual(await decideGuardrails(bank.id, [], { opaUrl: 'http://127.0.0.1:1' }), { allow: false, reason: 'policy_unreachable', violated: [], guardrails: [] });
});
