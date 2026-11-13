#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    The os-ui-worker pod holds no admin credentials
 * USER STORY: As a security reviewer I want CI to fail the moment somebody points the worker
 *             Deployment at the full `soa.osUI.env` again, because that puts the LiteLLM MASTER
 *             key, the session-signing secret and the mail secret on the agent-run path — a pod
 *             that serves no HTTP and executes model-driven tool calls.
 * ARCHITECTURE:
 *   - Renders the chart with the worker enabled and asserts, on the RENDERED Deployments:
 *     (1) no admin credential name appears in `os-ui-worker`; (2) the run path's own credentials
 *     (the scoped agent key, the run store, Langfuse) DO; (3) `os-ui` still carries every admin
 *     name, so the split did not simply drop them.
 *   - SKIPS (exit 0, loudly) when `helm` is not on PATH — the unit gate must run on a laptop with
 *     no Kubernetes tooling. `docs/components/os-ui.md` carries the same check by hand.
 *   - No dependencies, no YAML parser: it splits the manifest stream and matches `- name: X`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const VALUES = join(repo, 'values.local.yaml');

/** Never on the run path: full gateway admin, session forging, outbound mail. */
const ADMIN_ONLY = ['LITELLM_MASTER_KEY', 'LITELLM_UI_USERNAME', 'LITELLM_UI_PASSWORD', 'GRAPH_CLIENT_SECRET', 'OS_SESSION_SECRET', 'OS_MCP_TOKEN_SECRET'];
/** The run path cannot work without these, so their absence is a broken split, not a safe one. */
const RUN_PATH = ['LITELLM_AGENT_KEY', 'AGENT_RUNS_DATABASE_URL', 'LANGFUSE_SECRET_KEY', 'OPA_URL'];

function helmAvailable() {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function deployments(text) {
  const out = new Map();
  for (const doc of text.split(/^---$/m)) {
    if (!/^kind: Deployment$/m.test(doc)) continue;
    const name = doc.match(/^metadata:\n(?:.*\n)*?\s{2}name: (\S+)$/m)?.[1] ?? doc.match(/^\s{2}name: (\S+)$/m)?.[1];
    if (name) out.set(name, doc);
  }
  return out;
}

const names = (doc) => new Set([...doc.matchAll(/^\s+- name: ([A-Z0-9_]+)$/gm)].map((m) => m[1]));

if (!helmAvailable()) {
  console.log('check-worker-env: helm not on PATH — SKIPPED (see docs/components/os-ui.md for the manual check)');
  process.exit(0);
}
if (!existsSync(VALUES)) {
  console.log(`check-worker-env: ${VALUES} missing — SKIPPED`);
  process.exit(0);
}

const rendered = execFileSync('helm', ['template', CHART, '-f', VALUES, '--set', 'osUI.worker.enabled=true', '--set', 'osUI.graph.enabled=true'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const found = deployments(rendered);
const worker = found.get('os-ui-worker');
const osui = found.get('os-ui');
const problems = [];
if (!worker) problems.push('os-ui-worker Deployment not rendered with osUI.worker.enabled=true');
if (!osui) problems.push('os-ui Deployment not rendered');

if (worker) {
  const have = names(worker);
  for (const n of ADMIN_ONLY) if (have.has(n)) problems.push(`os-ui-worker carries the ADMIN-ONLY env ${n} — include soa.osUI.runEnv, not soa.osUI.env`);
  for (const n of RUN_PATH) if (!have.has(n)) problems.push(`os-ui-worker is MISSING the run-path env ${n} — the split dropped something a run needs`);
}
if (osui) {
  const have = names(osui);
  for (const n of ADMIN_ONLY) if (!have.has(n)) problems.push(`os-ui is MISSING ${n} — soa.osUI.env must still include soa.osUI.adminEnv`);
}

if (problems.length) {
  console.error('check-worker-env FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-worker-env: ok — os-ui-worker holds none of ${ADMIN_ONLY.length} admin credentials and all ${RUN_PATH.length} run-path ones`);
