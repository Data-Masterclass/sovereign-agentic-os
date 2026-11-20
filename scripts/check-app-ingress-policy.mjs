#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — the annotation allow-list for app Ingresses
 * USER STORY: As an operator I want the runner's own check and the API server's admission policy
 *             to allow exactly the same Ingress annotations, so neither door is wider than the other.
 * ARCHITECTURE:
 *   - Static half (always runs): the chart's default `softwareRunner.ingressPolicy.allowedAnnotations`
 *     equals `APP_INGRESS_ANNOTATION_ALLOWLIST` in os-ui/tabs/software/lib/app-ingress-policy.ts,
 *     and the policy is on by default.
 *   - Rendered half (needs helm): with `softwareRunner.enabled` on the default and the STACKIT
 *     profile, the chart renders the ValidatingAdmissionPolicy and its Deny binding, scoped to the
 *     runner namespace, carrying that list; with `ingressPolicy.enabled=false` it renders neither.
 *     Skips loudly without helm or the subchart tarballs; in CI (`process.env.CI`) a skip is a FAILURE.
 *   - Wired into os-ui/scripts/gate.sh.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const STACKIT = join(repo, 'values.stackit-managed.yaml');
const TEMPLATE = 'templates/base/os-ui/apps-ingress-admission.yaml';
const problems = [];

const require = createRequire(resolve(repo, 'os-ui/package.json'));
const yaml = require('js-yaml');

// ── static half ────────────────────────────────────────────────────────────────────────────
const src = readFileSync(join(repo, 'os-ui/tabs/software/lib/app-ingress-policy.ts'), 'utf8');
const m = src.match(/APP_INGRESS_ANNOTATION_ALLOWLIST[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
const osList = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
if (!osList) problems.push('app-ingress-policy.ts: APP_INGRESS_ANNOTATION_ALLOWLIST not found');
const values = yaml.load(readFileSync(join(CHART, 'values.yaml'), 'utf8'));
const ip = values?.softwareRunner?.ingressPolicy ?? {};
if (ip.enabled !== true) problems.push('values.yaml: softwareRunner.ingressPolicy.enabled must default to true');
const chartList = ip.allowedAnnotations ?? [];
if (osList && JSON.stringify([...chartList].sort()) !== JSON.stringify([...osList].sort())) {
  problems.push(`allow-lists differ: chart ${JSON.stringify(chartList)} vs os-ui ${JSON.stringify(osList)}`);
}

// ── rendered half ──────────────────────────────────────────────────────────────────────────
function render(extra) {
  return execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation',
    '--set', 'softwareRunner.enabled=true', '--show-only', TEMPLATE, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
let helmOk = true;
try {
  execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
} catch {
  helmOk = false;
}
const depsOk = existsSync(join(CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
if (!helmOk || !depsOk) {
  const msg = `check-app-ingress-policy: ${helmOk ? 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)' : 'helm not on PATH'} — rendered half SKIPPED`;
  if (process.env.CI) problems.push(msg);
  else console.warn(msg);
} else {
  for (const [label, extra] of [['default', []], ['stackit', ['-f', STACKIT]]]) {
    let docs;
    try {
      docs = yaml.loadAll(render(extra)).filter(Boolean);
    } catch (e) {
      problems.push(`${label}: render failed: ${String(e.stderr || e.message).slice(0, 300)}`);
      continue;
    }
    const vap = docs.find((d) => d.kind === 'ValidatingAdmissionPolicy');
    const bind = docs.find((d) => d.kind === 'ValidatingAdmissionPolicyBinding');
    if (!vap || !bind) { problems.push(`${label}: policy or binding not rendered`); continue; }
    const ns = vap.spec?.matchConstraints?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'];
    const wantNs = (label === 'stackit' ? yaml.load(readFileSync(STACKIT, 'utf8'))?.softwareRunner?.namespace : null) ?? values.softwareRunner.namespace;
    if (ns !== wantNs) problems.push(`${label}: policy scoped to namespace ${ns}, want ${wantNs}`);
    const allowed = JSON.parse(vap.spec?.variables?.find((v) => v.name === 'allowed')?.expression ?? 'null');
    const want = [...chartList, 'kubectl.kubernetes.io/last-applied-configuration'];
    if (JSON.stringify(allowed) !== JSON.stringify(want)) problems.push(`${label}: rendered allow-list ${JSON.stringify(allowed)}`);
    if (vap.spec?.failurePolicy !== 'Fail') problems.push(`${label}: failurePolicy must be Fail`);
    if (JSON.stringify(bind.spec?.validationActions) !== '["Deny"]') problems.push(`${label}: binding must Deny`);
    if (bind.spec?.policyName !== vap.metadata?.name) problems.push(`${label}: binding names another policy`);
  }
  try {
    const off = render(['--set', 'softwareRunner.ingressPolicy.enabled=false']);
    problems.push(`enabled=false still renders: ${off.slice(0, 80)}`);
  } catch (e) {
    if (!/could not find template/.test(String(e.stderr))) problems.push(`enabled=false: ${String(e.stderr).slice(0, 200)}`);
  }
}

if (problems.length) {
  console.error('check-app-ingress-policy: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-app-ingress-policy: ok — app Ingress annotations ${JSON.stringify(chartList)} in os-ui and the admission policy`);
