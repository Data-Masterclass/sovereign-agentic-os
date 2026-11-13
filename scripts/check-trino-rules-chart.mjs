#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    The Trino access-rules feature is wired consistently across the chart
 * USER STORY: As a reviewer I want CI to fail the moment the reconciler stops running on a DEFAULT
 *             install, the Dagster run pod connects as a user the rules deny, or the os-ui Role
 *             widens back to namespace-wide Secrets — the three defects of the B3 review that a
 *             unit test cannot see, because they live in rendered YAML.
 * ARCHITECTURE:
 *   - Four renders: stock values; `osUI.dataProjectGit.enabled=true`;
 *     `trino.accessControl.enabled=false`; `trino.opa.enabled=false`. Each asserts the SAME
 *     invariant — os-ui carries `TRINO_ACCESS_RULES` if and only if the `trino-access-rules`
 *     ConfigMap renders (B3-review-H-1/L-5).
 *   - Plus: the Dagster code location's `TRINO_USER` equals `trino.accessControl.serviceUser`
 *     (H-5, read straight out of values.yaml — a subchart's values cannot be templated), and the
 *     os-ui Role grants `secrets` only under `externalConnectorsEnabled`, with a ConfigMap grant
 *     scoped by `resourceNames` (H-6).
 *   - Plus (B4-review-H-2): the Role carries a `batch`/`cronjobs` rule in EVERY render — including
 *     `osUI.dataProjectGit.enabled=false` — because the agent-schedule reconciler creates and
 *     deletes CronJobs independent of that flag, while the data-sync cleanup only deletes. The
 *     review asked for the rule to appear *iff* the flag is on; that would 403 every agent cron
 *     save on an opted-out install, so the rule is unconditional and this check pins it both ways.
 *   - SKIPS (exit 0, loudly) when `helm` is not on PATH OR a subchart `.tgz` is missing — the unit
 *     gate must run on a laptop with neither. docs/components/trino.md carries the commands.
 *   - **In CI (`process.env.CI`) a skip is a hard FAILURE.** A check that silently skips on the
 *     one machine that is supposed to enforce it is not a check, and the CI runner has helm but
 *     NOT the gitignored subchart tarballs, so this skipped on every run until the workflow
 *     learned to `helm dependency build` first (deviation F-7).
 *   - No dependencies, no YAML parser: it splits the manifest stream and matches lines.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const SUBCHARTS = join(CHART, 'charts');
const VALUES_YAML = join(CHART, 'values.yaml');

function helmAvailable() {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function skip(why) {
  if (process.env.CI) {
    console.error(`check-trino-rules-chart: ${why} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` (or install helm) before the gate; a chart check may not silently skip in CI.`);
    process.exit(1);
  }
  console.log(`check-trino-rules-chart: ${why} — SKIPPED (see docs/components/trino.md for the manual check)`);
  process.exit(0);
}

if (!helmAvailable()) skip('helm not on PATH');
if (!existsSync(SUBCHARTS) || readdirSync(SUBCHARTS).filter((f) => f.endsWith('.tgz')).length === 0) {
  skip('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');
}

const problems = [];

function render(sets) {
  const args = ['template', CHART];
  for (const s of sets) args.push('--set', s);
  return execFileSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function docs(text) {
  return text.split(/^---$/m);
}

function osUiDeployment(text) {
  return docs(text).find((d) => /^kind: Deployment$/m.test(d) && /^\s{2}name: os-ui$/m.test(d)) ?? '';
}

function osUiRole(text) {
  return docs(text).find((d) => /^kind: Role$/m.test(d) && /^\s{2}name: os-ui$/m.test(d)) ?? '';
}

/** The verbs of the first rule whose `resources:` line names `cronjobs`, or null when there is none.
 *  Comments are ignored: only a real `resources: [...]` line followed by a `verbs: [...]` counts. */
function cronJobVerbs(role) {
  const m = role.match(/^\s*- apiGroups: \["batch"\]\s*\n\s*resources: \[(.*?)\]\s*\n\s*verbs: \[(.*?)\]\s*$/m);
  if (!m || !/"cronjobs"/.test(m[1])) return null;
  return m[2].split(',').map((v) => v.trim().replace(/"/g, ''));
}

/** Only the `resources:` lines count — a comment that MENTIONS secrets is not a grant. */
function grantsSecrets(role) {
  return [...role.matchAll(/^\s*resources: \[(.*)\]\s*$/gm)].some((m) => /"secrets"/.test(m[1]));
}

function hasRulesConfigMap(text) {
  return docs(text).some((d) => /^kind: ConfigMap$/m.test(d) && /^\s{2}name: trino-access-rules$/m.test(d));
}

// ---- 1. H-1 / L-5: the env flag renders exactly when the ConfigMap does.
const CASES = [
  { label: 'stock values', sets: [] },
  { label: 'osUI.dataProjectGit.enabled=true', sets: ['osUI.dataProjectGit.enabled=true'] },
  { label: 'osUI.dataProjectGit.enabled=false', sets: ['osUI.dataProjectGit.enabled=false'] },
  { label: 'trino.accessControl.enabled=false', sets: ['trino.accessControl.enabled=false'] },
  { label: 'trino.opa.enabled=false', sets: ['trino.opa.enabled=false'] },
];

for (const c of CASES) {
  const text = render(c.sets);
  const cm = hasRulesConfigMap(text);
  const env = /^\s+- name: TRINO_ACCESS_RULES$/m.test(osUiDeployment(text));
  if (cm !== env) {
    problems.push(
      `${c.label}: trino-access-rules ConfigMap ${cm ? 'RENDERS' : 'does not render'} but os-ui ${env ? 'HAS' : 'lacks'} TRINO_ACCESS_RULES — the two gates must be identical (B3-review-H-1/L-5)`,
    );
  }
  if (cm && !/^\s+- name: TRINO_DBT_USER$/m.test(osUiDeployment(text))) {
    problems.push(`${c.label}: TRINO_ACCESS_RULES without TRINO_DBT_USER — the reconciler would guess the service user`);
  }
  if (c.label === 'stock values' && !cm) {
    problems.push('stock values render no trino-access-rules ConfigMap — the defaults changed; re-read this check');
  }

  // ---- 3. H-6: Secrets stay on the external-connector flag; the ConfigMap grant is named.
  const role = osUiRole(text);
  if (!role) problems.push(`${c.label}: no os-ui Role rendered`);
  if (role && grantsSecrets(role)) {
    problems.push(`${c.label}: the os-ui Role grants \`secrets\` with externalConnectorsEnabled OFF (B3-review-H-6)`);
  }
  if (role && cm && !/resourceNames: \["trino-access-rules"\]/.test(role)) {
    problems.push(`${c.label}: the os-ui Role has no resourceNames-scoped configmaps rule for trino-access-rules (B3-review-H-6)`);
  }

  // ---- 4. B4-review-H-2: the batch/cronjobs grant, in every render.
  const verbs = cronJobVerbs(role);
  if (!verbs) {
    problems.push(
      `${c.label}: the os-ui Role has no \`batch\`/\`cronjobs\` rule — agent schedule CronJobs (create/update/delete) and the pre-B2 data-sync cleanup (delete) both 403 (B4-review-H-2)`,
    );
  } else {
    for (const need of ['get', 'create', 'update', 'delete']) {
      if (!verbs.includes(need)) {
        problems.push(`${c.label}: the os-ui Role's batch/cronjobs rule lacks \`${need}\` — ${need === 'delete' ? 'the pre-B2 data-sync cleanup' : 'the agent schedule reconciler'} needs it (B4-review-H-2)`);
      }
    }
    for (const forbidden of ['*', 'deletecollection']) {
      if (verbs.includes(forbidden)) problems.push(`${c.label}: the os-ui Role's batch/cronjobs rule grants \`${forbidden}\` — wider than any caller needs`);
    }
  }
}

// externalConnectorsEnabled=true is the ONE case that may grant Secrets.
{
  const role = osUiRole(render(['osUI.externalConnectorsEnabled=true']));
  if (!grantsSecrets(role)) problems.push('osUI.externalConnectorsEnabled=true: the os-ui Role lost its Secrets grant — external catalog registration needs it');
}

// ---- 2. H-5: the Dagster code location connects as the rules file's service user.
{
  const values = readFileSync(VALUES_YAML, 'utf8');
  const serviceUser = values.match(/^\s{4}serviceUser:\s*(\S+)\s*$/m)?.[1];
  const trinoUser = values.match(/^\s*- \{ name: TRINO_USER, value: (\S+?) \}\s*$/m)?.[1];
  if (!serviceUser) problems.push('values.yaml: trino.accessControl.serviceUser not found');
  if (!trinoUser) problems.push('values.yaml: the Dagster code location has no TRINO_USER entry');
  if (serviceUser && trinoUser && serviceUser !== trinoUser) {
    problems.push(
      `values.yaml: the Dagster run pod connects as TRINO_USER=${trinoUser} but rules.json only lets ${serviceUser} become an OS principal (B3-review-H-5)`,
    );
  }
}

if (problems.length) {
  console.error('check-trino-rules-chart FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-trino-rules-chart: ok — env/ConfigMap gates agree on ${CASES.length} value sets, TRINO_USER matches serviceUser, ` +
    'Role grants no Secrets without externalConnectors, batch/cronjobs granted in every render',
);
