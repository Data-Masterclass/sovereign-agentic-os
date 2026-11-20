#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — the os_governance bootstrap hook can never use or damage another
 *             service's credential, database or role
 * USER STORY: As an operator I want the render to fail the moment the governance bootstrap is
 *             pointed at Langfuse's login, or at a database or role another service owns, because
 *             that hook runs as a superuser and would demote, re-password or re-own it.
 * ARCHITECTURE:
 *   - Renders the chart (`helm template`) and asserts:
 *       1. default values, and the STACKIT profile           → the hook does not render (off);
 *       2. enabled + a dedicated adminSecretName              → the Job renders, connects with THAT
 *          Secret, and no line of it names `postgres.secretName` (the control: proves 3-5 are not
 *          passing because nothing renders at all);
 *       3. enabled without adminSecretName, or with postgres.secretName / the Langfuse Secret
 *                                                             → the render FAILS;
 *       4. database / owner / runtime / queue name equal to langfuse, postgres, litellm, dagster,
 *          polaris or agent_runs                              → the render FAILS, for every field;
 *       5. two of owner / runtime / queue equal               → the render FAILS.
 *     "An existing superuser" cannot be known at render time; roles.sql refuses it at run time,
 *     proven in os-ui/core/adapters/postgres/install.it.ts.
 *   - SKIPS loudly without helm or the subchart `.tgz` files; in CI a skip is a FAILURE (same rule
 *     as check-worker-env.mjs). Wired into os-ui/scripts/gate.sh.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const LOCAL = join(repo, 'values.local.yaml');
const STACKIT = join(repo, 'values.stackit-managed.yaml');
const TEMPLATE = 'templates/base/postgres/os-governance-bootstrap.yaml';
const NAME = 'check-governance-bootstrap-chart';

function skip(why) {
  if (process.env.CI) {
    console.error(`${NAME}: ${why} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` before the gate.`);
    process.exit(1);
  }
  console.log(`${NAME}: ${why} — SKIPPED`);
  process.exit(0);
}
try {
  execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
} catch {
  skip('helm not on PATH');
}
const tgz = join(CHART, 'charts');
if (!existsSync(tgz) || !readdirSync(tgz).some((f) => f.endsWith('.tgz'))) skip('no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)');

/** Render; returns { ok, out }. `sets` are --set pairs. */
function render(files, sets = []) {
  const args = ['template', 'agentic-os', CHART];
  for (const f of files) args.push('-f', f);
  for (const s of sets) args.push('--set', s);
  const r = spawnSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
}
const hookDocs = (text) => text.split(/^---$/m).filter((d) => /name: os-governance-bootstrap/.test(d));

const problems = [];
const ON = ['postgres.governance.enabled=true', 'postgres.governance.adminSecretName=pg-governance-bootstrap-admin'];

// 1. off by default, on both profiles
for (const [label, files] of [['default', [LOCAL]], ['STACKIT', [STACKIT]]]) {
  const r = render(files);
  if (!r.ok) problems.push(`${label}: the chart does not render:\n${r.out.slice(-800)}`);
  else if (hookDocs(r.out).length) problems.push(`${label}: os-governance-bootstrap renders although postgres.governance.enabled defaults to false`);
}

// 2. the control: enabled with a dedicated admin Secret renders, and uses only that Secret
{
  const r = render([LOCAL], ON);
  const job = hookDocs(r.out).find((d) => /^kind: Job$/m.test(d));
  if (!r.ok || !job) problems.push(`enabled: the Job does not render:\n${r.out.slice(-800)}`);
  else {
    const user = job.match(/- name: PGUSER\n\s+valueFrom: \{ secretKeyRef: \{ name: (\S+), key: username \} \}/)?.[1];
    if (user !== 'pg-governance-bootstrap-admin') problems.push(`enabled: PGUSER comes from ${user}, not the dedicated admin Secret`);
    if (/postgres-langfuse-credentials/.test(job)) problems.push('enabled: the Job references postgres-langfuse-credentials');
  }
}

// 3. the admin credential must be dedicated
for (const [label, sets, why] of [
  ['no adminSecretName', ['postgres.governance.enabled=true'], /adminSecretName is required/],
  ['adminSecretName = the Langfuse Secret', ['postgres.governance.enabled=true', 'postgres.governance.adminSecretName=postgres-langfuse-credentials'], /another service's credential/],
]) {
  const r = render([LOCAL], sets);
  if (r.ok) problems.push(`${label}: rendered, must FAIL`);
  else if (!why.test(r.out)) problems.push(`${label}: failed for the wrong reason:\n${r.out.slice(-400)}`);
}

// 4. no field may name another service's database or role
const FIELDS = ['database', 'owner.username', 'runtime.username', 'queue.username'];
for (const field of FIELDS) {
  for (const taken of ['langfuse', 'postgres', 'litellm', 'dagster', 'polaris', 'agent_runs']) {
    const r = render([LOCAL], [...ON, `postgres.governance.${field}=${taken}`]);
    if (r.ok) problems.push(`postgres.governance.${field}=${taken}: rendered, must FAIL`);
    else if (!/collides with an existing service/.test(r.out)) problems.push(`postgres.governance.${field}=${taken}: failed for the wrong reason:\n${r.out.slice(-400)}`);
  }
}

// 5. three distinct roles
{
  const r = render([LOCAL], [...ON, 'postgres.governance.runtime.username=os_governance']);
  if (r.ok || !/three different roles/.test(r.out)) problems.push('owner = runtime: must FAIL with "three different roles"');
}

if (problems.length) {
  console.error(`${NAME}: FAIL\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`${NAME}: ok — off by default on both profiles; when enabled it connects only with the dedicated admin Secret; the Langfuse Secret, a missing admin Secret, any of ${FIELDS.length} names equal to another service's database or role, and two equal roles all fail the render`);
