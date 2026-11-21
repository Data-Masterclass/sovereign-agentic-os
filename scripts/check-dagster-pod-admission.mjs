#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Dagster run-pod shape (ValidatingAdmissionPolicy)
 * USER STORY: As an operator I want CI to fail when an identity that may create Pods or Jobs in
 *             the release namespace is not held to the run-pod shape, or when the policy would
 *             refuse the run pods Dagster really launches (wrong image or ServiceAccount list).
 * ARCHITECTURE:
 *   - Renders the chart (local, dev, STACKIT) with js-yaml and asserts:
 *     (1) the policy and its Deny binding render, failurePolicy Fail;
 *     (2) every ServiceAccount a RoleBinding grants create/update/patch on pods or jobs is in the
 *         policy's identity list, except the reviewed EXEMPT ones;
 *     (3) every image of the rendered code-location Deployment and of its run config
 *         (run_k8s_config) is on the image allowlist, and the run config's service_account_name is
 *         an allowed run ServiceAccount;
 *     (4) `dagsterPodAdmission.enabled=false` renders neither object.
 *   - CHART_DIR overrides the chart (negative twins in scripts/tests/dagster-pod-admission.test.sh).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = process.env.CHART_DIR ? resolve(process.env.CHART_DIR) : join(repo, 'charts', 'sovereign-agentic-os');
const TAG = 'check-dagster-pod-admission';
const NS = 'agentic-os';
const skip = (why) => {
  if (process.env.CI) { console.error(`${TAG}: ${why} — FAILING because CI is set.`); process.exit(1); }
  console.log(`${TAG}: ${why} — SKIPPED`); process.exit(0);
};
let yaml;
try { yaml = createRequire(join(repo, 'os-ui', 'package.json'))('js-yaml'); } catch { skip('js-yaml not installed (os-ui/node_modules)'); }
try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); } catch { skip('helm not installed'); }
const sub = join(CHART, 'charts');
if (!(existsSync(sub) && readdirSync(sub).some((f) => f.endsWith('.tgz')))) skip('subcharts not built');

// Reviewed identities that may write Pods/Jobs but are NOT Dagster run launchers.
const EXEMPT = { 'os-ui': 'the governed control plane; it creates only chart-defined Jobs and CronJobs' };
const POLICY = 'agentic-os-dagster-run-pod-shape';
const failures = [];
const render = (...a) => yaml.loadAll(execFileSync('helm', ['template', 'agentic-os', CHART, '-n', NS, '--skip-schema-validation', '--set', 'global.allowChartDefaultSecrets=true', ...a], { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] })).filter(Boolean);
const lit = (expr) => JSON.parse(expr.slice(expr.indexOf('[')));  // the JSON list literal in a CEL `x in [...]`

const profiles = { local: ['-f', join(repo, 'values.local.yaml')], dev: ['-f', join(repo, 'values.dev.yaml')], stackit: ['-f', join(repo, 'values.stackit-managed.yaml')] };
// The opt-in launcher lock-down overlay (custom run launcher) must keep its run pods admitted.
if (existsSync(join(repo, 'values.dagster-launcher-lockdown.yaml'))) profiles['dev+launcher-lockdown'] = [...profiles.dev, '-f', join(repo, 'values.dagster-launcher-lockdown.yaml')];
for (const [profile, args] of Object.entries(profiles)) {
  const objs = render(...args);
  const fail = (m) => failures.push(`[${profile}] ${m}`);
  const codeServer = objs.find((d) => d.kind === 'Deployment' && d.spec?.template?.metadata?.labels?.['app.kubernetes.io/name'] === 'dagster-user-deployments');
  if (!codeServer) continue; // Dagster not rendered on this profile
  const vap = objs.find((d) => d.kind === 'ValidatingAdmissionPolicy' && d.metadata.name === POLICY);
  const bind = objs.find((d) => d.kind === 'ValidatingAdmissionPolicyBinding' && d.spec?.policyName === POLICY);
  if (!vap || !bind) { fail('the run-pod shape policy or its binding is not rendered'); continue; }
  if (vap.spec.failurePolicy !== 'Fail') fail('failurePolicy must be Fail');
  if (JSON.stringify(bind.spec.validationActions) !== '["Deny"]') fail('the binding must Deny');
  const users = lit(vap.spec.matchConditions[0].expression);
  const imageRule = vap.spec.validations.find((v) => v.expression.startsWith('variables.containers.all(c, c.image in'));
  const saRule = vap.spec.validations.find((v) => v.expression.includes('serviceAccountName'));
  const images = imageRule ? lit(imageRule.expression.replace(/\)$/, '')) : [];
  const runSAs = saRule ? lit(saRule.expression) : [];

  const roles = new Map(objs.filter((d) => d.kind === 'Role' || d.kind === 'ClusterRole').map((d) => [`${d.kind}/${d.metadata.name}`, d]));
  for (const b of objs.filter((d) => d.kind === 'RoleBinding' && (d.metadata.namespace ?? NS) === NS)) {
    const r = roles.get(`${b.roleRef.kind}/${b.roleRef.name}`);
    const writes = (r?.rules ?? []).some((x) => (x.resources ?? []).some((res) => ['pods', 'jobs', '*'].includes(res)) && (x.verbs ?? []).some((v) => ['create', 'update', 'patch', '*'].includes(v)));
    if (!writes) continue;
    for (const s of b.subjects ?? []) {
      if (s.kind !== 'ServiceAccount' || EXEMPT[s.name]) continue;
      if (!users.includes(`system:serviceaccount:${s.namespace ?? NS}:${s.name}`)) fail(`ServiceAccount ${s.name} may write Pods/Jobs (${b.metadata.name}) but is not held to the run-pod shape`);
    }
  }
  // The run config lives in the code location's env (includeConfigInLaunchedRuns, the default) or,
  // with a custom launcher (values.dagster-launcher-lockdown.yaml), in the instance ConfigMap.
  const instance = objs.filter((d) => d.kind === 'ConfigMap' && /dagster.*instance/.test(d.metadata.name)).map((d) => JSON.stringify(d.data ?? {})).join('');
  const text = JSON.stringify(codeServer.spec.template.spec) + instance;
  const codeImages = codeServer.spec.template.spec.containers.map((c) => c.image);
  const runImages = [...text.matchAll(/\\+"image\\+": ?\\+"([^\\"]+)\\+"/g), ...text.matchAll(/\\n\s*-?\s*image: ([^\s\\]+)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));
  for (const img of new Set([...codeImages, ...runImages])) if (!images.includes(img)) fail(`Dagster image ${img} is not on the run-pod image allowlist`);
  const runSa = text.match(/\\+"service_account_name\\+": ?\\+"([^\\"]+)\\+"/)?.[1] ?? text.match(/service_account_name: ([\w-]+)/)?.[1];
  if (!runSa) fail('no service_account_name in the rendered run config');
  else if (!runSAs.includes(runSa)) fail(`the run config's ServiceAccount ${runSa} is not an allowed run ServiceAccount`);
  console.log(`${TAG}: [${profile}] ${users.length} launcher identities, ${images.length} images, run SA ${runSa}`);
}
const off = render('-f', join(repo, 'values.dev.yaml'), '--set', 'dagsterPodAdmission.enabled=false');
if (off.some((d) => d.kind?.startsWith('ValidatingAdmissionPolicy') && (d.metadata.name === POLICY || d.spec?.policyName === POLICY))) failures.push('dagsterPodAdmission.enabled=false still renders the policy');
if (failures.length) { for (const f of failures) console.error(`${TAG}: FAIL ${f}`); process.exit(1); }
console.log(`${TAG}: OK`);
