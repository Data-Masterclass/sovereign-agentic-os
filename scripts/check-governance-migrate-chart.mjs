#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — the os_governance migrations have a production caller, and OPA's bundle
 *             volume is writable by OPA
 * USER STORY: As an operator I want a release with the governance store enabled to install its schema
 *             itself, and OPA to persist its bundles, because without them OPA never becomes Ready
 *             and every OPA-checked action answers `opa-unreachable` (dev, 21-22 Nov 2026).
 * ARCHITECTURE:
 *   - Renders the chart (`helm template`) and asserts:
 *       1. default values, and the STACKIT profile        → no migration Job (governance is off);
 *       2. governance enabled → a Helm hook Job `os-governance-migrate`:
 *            post-install,post-upgrade, ordered AFTER the bootstrap hook (weight 6), the os-ui image,
 *            the command `worker/migrate-governance.mjs`, the OWNER Secret only (never the admin or the
 *            runtime Secret), backoffLimit set, and no `hook-delete-policy` that deletes a FAILED run;
 *       3. the Postgres ingress policy admits the Job's pods (a missed peer times out);
 *       4. OPA with a persistent bundle volume runs with `fsGroup: 1000` and
 *          `fsGroupChangePolicy: OnRootMismatch`; with `persistence.enabled=false`, with neither.
 *   - SKIPS loudly without helm or the subchart `.tgz` files; in CI a skip is a FAILURE.
 *   - Wired into os-ui/scripts/gate.sh.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const LOCAL = join(repo, 'values.local.yaml');
const STACKIT = join(repo, 'values.stackit-managed.yaml');
const NAME = 'check-governance-migrate-chart';

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

function render(files, sets = []) {
  const args = ['template', 'agentic-os', CHART];
  for (const f of files) args.push('-f', f);
  for (const s of sets) args.push('--set', s);
  const r = spawnSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}` };
}
const docs = (text) => text.split(/^---$/m);
const named = (text, kind, name) => docs(text).find((d) => new RegExp(`^kind: ${kind}$`, 'm').test(d) && new RegExp(`^  name: ${name}$`, 'm').test(d));

const problems = [];
const GOV = ['postgres.governance.enabled=true', 'postgres.governance.adminSecretName=pg-governance-bootstrap-admin'];

// 1. off by default on both profiles
for (const [label, files] of [['default', [LOCAL]], ['STACKIT', [STACKIT]]]) {
  const r = render(files);
  if (!r.ok) problems.push(`${label}: the chart does not render:\n${r.out.slice(-800)}`);
  else if (/name: os-governance-migrate\b/.test(r.out)) problems.push(`${label}: os-governance-migrate renders although postgres.governance.enabled defaults to false`);
}

// 2 + 3. enabled: the migration Job
{
  const r = render([LOCAL], GOV);
  const job = r.ok ? named(r.out, 'Job', 'os-governance-migrate') : undefined;
  if (!job) problems.push(`governance enabled: no Job os-governance-migrate renders (the migrations have no production caller):\n${r.out.slice(-600)}`);
  else {
    if (!/"helm.sh\/hook": post-install,post-upgrade/.test(job)) problems.push('migrate Job: not a post-install,post-upgrade hook');
    const w = Number(job.match(/"helm.sh\/hook-weight": "(-?\d+)"/)?.[1]);
    if (!(w > 6)) problems.push(`migrate Job: hook-weight ${w} must be > 6 (after os-governance-bootstrap, which creates the owner role and the database)`);
    if (/hook-delete-policy":[^\n]*hook-failed/.test(job)) problems.push('migrate Job: deletes itself when it FAILS — the failure must stay inspectable');
    if (!/worker\/migrate-governance\.mjs/.test(job)) problems.push('migrate Job: does not run worker/migrate-governance.mjs');
    if (!/image: "[^"]*os-ui:/.test(job)) problems.push('migrate Job: not the os-ui image');
    if (!/backoffLimit: \d+/.test(job)) problems.push('migrate Job: no backoffLimit');
    if (!/secretName|name: postgres-os-governance-owner-credentials/.test(job) && !/postgres-os-governance-owner-credentials/.test(job)) problems.push('migrate Job: does not read the owner Secret');
    for (const bad of ['pg-governance-bootstrap-admin', 'postgres-os-governance-runtime-credentials', 'postgres-os-governance-queue-credentials', 'postgres-langfuse-credentials']) {
      if (job.includes(bad)) problems.push(`migrate Job: references ${bad} (it must connect only as the owner)`);
    }
    if (!/OS_GOVERNANCE_OWNER_DATABASE_URL/.test(job)) problems.push('migrate Job: no OS_GOVERNANCE_OWNER_DATABASE_URL');
    const np = docs(r.out).find((d) => /^kind: NetworkPolicy$/m.test(d) && /app\.kubernetes\.io\/component: os-governance-bootstrap/.test(d) && /port: 5432/.test(d));
    if (!np) problems.push('Postgres ingress policy: not found');
    else if (!/app\.kubernetes\.io\/component: os-governance-migrate\b/.test(np)) problems.push('Postgres ingress policy: does not admit os-governance-migrate pods');
  }
}

// 4. OPA's persistent bundle volume
{
  const on = render([LOCAL], ['opa.dataBundle.enabled=true']);
  const dep = on.ok ? named(on.out, 'Deployment', 'opa') : undefined;
  if (!dep) problems.push(`opa.dataBundle.enabled: no opa Deployment renders:\n${on.out.slice(-400)}`);
  else {
    if (!/fsGroup: 1000/.test(dep)) problems.push('opa with persistence: no fsGroup: 1000 — the root-owned PVC is unwritable for runAsUser 1000 (mkdir /var/opa/bundles: permission denied)');
    if (!/fsGroupChangePolicy: OnRootMismatch/.test(dep)) problems.push('opa with persistence: no fsGroupChangePolicy: OnRootMismatch');
  }
  const off = render([LOCAL], ['opa.dataBundle.enabled=true', 'opa.dataBundle.persistence.enabled=false']);
  const d2 = off.ok ? named(off.out, 'Deployment', 'opa') : undefined;
  if (!d2) problems.push('opa without persistence: no opa Deployment renders');
  else if (/fsGroup/.test(d2)) problems.push('opa without persistence (emptyDir): fsGroup is set although nothing needs it');
}

if (problems.length) {
  console.error(`${NAME}: FAIL\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`${NAME}: ok — no migration Job by default on both profiles; with the governance store it runs as a post-install/upgrade hook after the bootstrap, as the owner only, from the os-ui image, and Postgres admits it; OPA's persistent volume is group-writable (fsGroup 1000, OnRootMismatch) and only then`);
