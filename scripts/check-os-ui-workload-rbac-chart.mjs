#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    os-ui cannot rewrite platform workloads in the release namespace
 * USER STORY: As the owner I want CI to fail when a render lets the os-ui (or os-ui-worker)
 *             ServiceAccount change a platform workload beyond what its features use — patch/update of
 *             any Deployment other than `trino`, of the workload object instead of its `/scale`, of a
 *             component the Platform page cannot toggle, any write to StatefulSets/DaemonSets/ReplicaSets/
 *             Pods, pod exec — or when the admission policy that fences its CronJob/Job creates and the
 *             trino patch is missing, not Deny/Fail, or not applicable on dev.
 * ARCHITECTURE:
 *   - Renders the chart (values.local.yaml) in several value sets — external connectors off/on, the worker,
 *     the software runner, the App Builder registry (a test builder digest on a COPY of the chart, as
 *     check-software-apps-envs-chart.mjs does) — and resolves, from the RENDERED manifests, every Role bound
 *     to os-ui / os-ui-worker IN THE RELEASE NAMESPACE (and every ClusterRole bound anywhere).
 *   - Asks what Kubernetes RBAC would answer for each workload verb: a rule with `resourceNames` grants
 *     those names only; `*` matches everything; `create`/`list`/`watch` ignore `resourceNames`.
 *   - Checks the os-ui-workload-shape ValidatingAdmissionPolicy + binding: rendered whenever os-ui is,
 *     failurePolicy Fail, validationActions [Deny], the two identities, the release namespace; the Job
 *     shapes it admits follow what RBAC grants (zot-users with the registry, the scan Job only while the
 *     scanner's Role is in the release namespace).
 *   - Dev: the CI account may update/delete an admission policy only by name — the policy's name must be in
 *     scripts/dev/manifests/ci-rbac.yaml.
 *   - Same skip rule as the other chart checks: a loud skip on a laptop without helm/subcharts, a FAILURE in CI.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'check-os-ui-workload-rbac-chart';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CHART = join(repo, 'charts', 'sovereign-agentic-os');
const VALUES = join(repo, 'values.local.yaml');
const CI_RBAC = join(repo, 'scripts', 'dev', 'manifests', 'ci-rbac.yaml');
const REL = 'agentic-os';
const SUBJECTS = new Set(['os-ui', 'os-ui-worker']);
const POLICY = `${REL}-os-ui-workload-shape`;

function skip(why) {
  if (process.env.CI) {
    console.error(`${NAME}: ${why} — FAILING because CI is set (run \`helm dependency build charts/sovereign-agentic-os\`).`);
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
if (!existsSync(VALUES)) skip(`${VALUES} missing`);
const sub = join(REAL_CHART, 'charts');
if (!(existsSync(sub) && readdirSync(sub).some((f) => f.endsWith('.tgz')))) skip('no subchart .tgz (helm dependency build)');
let yaml;
try {
  yaml = createRequire(join(repo, 'os-ui', 'package.json'))('js-yaml');
} catch {
  skip('js-yaml not installed (os-ui/node_modules)');
}

// The App Builder registry renders only with a builder digest from the gated list: a test digest, on a COPY.
const TEST_DIGEST = 'sha256:' + 'a'.repeat(64);
const tmpRoot = mkdtempSync(join(tmpdir(), 'osui-rbac-'));
const CHART = join(tmpRoot, 'sovereign-agentic-os');
cpSync(REAL_CHART, CHART, { recursive: true });
appendFileSync(join(CHART, 'files', 'builder-digests.txt'), `${TEST_DIGEST} builder-vtest 0\n`);
process.on('exit', () => rmSync(tmpRoot, { recursive: true, force: true }));

const render = (sets) =>
  yaml
    .loadAll(
      execFileSync('helm', ['template', REL, CHART, '-n', REL, '-f', VALUES, '--skip-schema-validation', ...sets.flatMap((s) => ['--set', s])], {
        encoding: 'utf8',
        maxBuffer: 1 << 27,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
    .filter((d) => d && typeof d === 'object');

const REGISTRY_ON = [
  'osUI.software.tekton.enabled=true', 'networkPolicies.apiserver.cidrs={10.96.0.1/32}', 'egressProxy.enabled=true',
  'softwareRunner.environments.enabled=true', 'osUI.software.registry.host=registry.dev.example.com',
  'osUI.software.registry.allowedSourceRanges={203.0.113.7/32}', `softwareRunner.environments.build.image=ghcr.io/example/builder@${TEST_DIGEST}`,
  'softwareRunner.environments.build.isolation=dedicated-nodes', 'softwareRunner.environments.build.dedicatedNodes.nodeSelector.pool=build',
];
const CASES = [
  { label: 'externalConnectorsEnabled=false', sets: ['osUI.externalConnectorsEnabled=false'] },
  { label: 'externalConnectorsEnabled=true', sets: ['osUI.externalConnectorsEnabled=true'], trino: true },
  { label: 'externalConnectorsEnabled=true + worker', sets: ['osUI.externalConnectorsEnabled=true', 'osUI.worker.enabled=true'], trino: true },
  { label: 'scanner off', sets: ['osUI.software.scanner.enabled=false'] },
  {
    label: 'externalConnectorsEnabled=true + worker + software runner + App Builder registry',
    sets: ['osUI.externalConnectorsEnabled=true', 'osUI.worker.enabled=true', 'softwareRunner.enabled=true', ...REGISTRY_ON],
    trino: true,
    zot: true,
  },
];

// The names the os-ui Role may scale: the chart's own list (os-ui/tabs/admin/lib/platform-rbac.test.ts pins it to REGISTRY).
const TPL = readFileSync(join(REAL_CHART, 'templates', 'base', 'os-ui', '_os-ui-workload-rbac.tpl'), 'utf8');
const chartList = (name) => JSON.parse(TPL.match(new RegExp(`define "${name.replace(/\./g, '\\.')}" -}}\\s*(\\[[^\\]]*\\])`))[1]);
const SCALE_OK = { 'deployments/scale': new Set(chartList('soa.osUI.toggleDeployments')), 'statefulsets/scale': new Set(chartList('soa.osUI.toggleStatefulSets')) };

const lower = (xs) => (xs ?? []).map((x) => String(x).toLowerCase());
const has = (xs, v) => lower(xs).some((x) => x === v || x === '*');
const WRITE = ['create', 'update', 'patch', 'delete', 'deletecollection'];
const problems = [];

for (const c of CASES) {
  let docs;
  try {
    docs = render(c.sets);
  } catch (e) {
    problems.push(`${c.label}: helm template failed — ${String(e.stderr ?? e.message).split('\n')[0]}`);
    continue;
  }
  const roles = new Map();
  for (const d of docs) {
    if (d.kind === 'Role') roles.set(`Role/${d.metadata?.namespace ?? REL}/${d.metadata?.name}`, d.rules ?? []);
    if (d.kind === 'ClusterRole') roles.set(`ClusterRole//${d.metadata?.name}`, d.rules ?? []);
  }
  const rules = []; // the rules that apply to os-ui / os-ui-worker in the release namespace
  for (const d of docs) {
    if (d.kind !== 'RoleBinding' && d.kind !== 'ClusterRoleBinding') continue;
    if (!(d.subjects ?? []).some((s) => s.kind === 'ServiceAccount' && SUBJECTS.has(s.name) && (s.namespace ?? REL) === REL)) continue;
    const ns = d.kind === 'ClusterRoleBinding' ? '*' : d.metadata?.namespace ?? REL;
    if (ns !== REL && ns !== '*') continue;
    const ref = d.roleRef ?? {};
    const key = ref.kind === 'ClusterRole' ? `ClusterRole//${ref.name}` : `Role/${ns}/${ref.name}`;
    for (const r of roles.get(key) ?? []) rules.push({ ...r, via: `${d.kind} ${d.metadata?.name} → ${ref.kind} ${ref.name}` });
  }
  const grants = (group, resource, verb) =>
    rules.filter((r) => has(r.apiGroups, group) && has(r.resources, resource) && has(r.verbs, verb));
  const names = (rs) => (rs.some((r) => !r.resourceNames?.length) ? null : new Set(rs.flatMap((r) => r.resourceNames)));

  // 1. The workload objects: no write at all, except `patch` of the one trino Deployment (external connectors on).
  for (const res of ['deployments', 'statefulsets', 'daemonsets', 'replicasets']) {
    for (const verb of WRITE) {
      const rs = grants('apps', res, verb);
      if (!rs.length) continue;
      const n = names(rs);
      const trinoPatch = res === 'deployments' && verb === 'patch' && n && [...n].every((x) => x === 'trino');
      if (trinoPatch && c.trino) continue;
      problems.push(`${c.label}: os-ui may ${verb} ${res}${n ? ` (${[...n].join(', ')})` : ' (EVERY one)'} in the release namespace — ${[...new Set(rs.map((r) => r.via))].join('; ')}`);
    }
  }
  if (c.trino && !grants('apps', 'deployments', 'patch').length) problems.push(`${c.label}: the os-ui Role lost \`patch\` of the trino Deployment — the live warehouse registration needs it`);
  // 2. /scale: patch only, by name, of the toggleable components.
  for (const res of ['deployments/scale', 'statefulsets/scale']) {
    for (const verb of WRITE) {
      const rs = grants('apps', res, verb);
      if (!rs.length) continue;
      const n = names(rs);
      if (verb !== 'patch') problems.push(`${c.label}: os-ui may ${verb} ${res} (the toggle needs patch only) — ${rs[0].via}`);
      else if (!n) problems.push(`${c.label}: os-ui may patch ${res} of EVERY workload — name the toggleable components (_os-ui-workload-rbac.tpl)`);
      else for (const x of n) if (!SCALE_OK[res].has(x)) problems.push(`${c.label}: os-ui may scale ${res.split('/')[0]} ${x}, which the Platform page cannot toggle`);
    }
    if (!grants('apps', res, 'patch').length) problems.push(`${c.label}: the os-ui Role lost patch of ${res} — the Platform toggle needs it`);
  }
  // 3. Pods: no write, no exec/attach/ephemeral containers.
  for (const res of ['pods', 'pods/exec', 'pods/attach', 'pods/ephemeralcontainers', 'pods/portforward']) {
    for (const verb of [...WRITE, 'get']) {
      if (res === 'pods' && verb === 'get') continue;
      const rs = grants('', res, verb);
      if (rs.length) problems.push(`${c.label}: os-ui may ${verb} ${res} in the release namespace — ${rs[0].via}`);
    }
  }
  // 3b. ConfigMaps: write only by name — trino-catalog (warehouse registration), trino-access-rules (rules reconciler).
  const CM_OK = new Set(['trino-catalog', 'trino-access-rules']);
  for (const verb of WRITE) {
    const rs = grants('', 'configmaps', verb);
    if (!rs.length) continue;
    const n = names(rs);
    if (!n || verb === 'create' || verb === 'deletecollection') problems.push(`${c.label}: os-ui may ${verb} EVERY ConfigMap in the release namespace (opa-policy, egress-proxy-config, the LiteLLM config…) — ${[...new Set(rs.map((r) => r.via))].join('; ')}`);
    else for (const x of n) if (!CM_OK.has(x)) problems.push(`${c.label}: os-ui may ${verb} ConfigMap ${x} — no os-ui code writes it`);
  }
  // 3c. Secrets: no delete; create/update (unnameable) only with the policy's trino-ext-* fence (checked below).
  for (const verb of ['delete', 'deletecollection', 'patch']) {
    const rs = grants('', 'secrets', verb);
    if (rs.length) problems.push(`${c.label}: os-ui may ${verb} Secrets in the release namespace — ${rs[0].via}`);
  }
  const secretWrites = grants('', 'secrets', 'create').length + grants('', 'secrets', 'update').length > 0;
  // 4. Jobs/CronJobs: Job create only with the registry or an in-namespace scanner; the policy must fence every create.
  const scannerHere = docs.some((d) => d.kind === 'Role' && d.metadata?.name === 'os-ui-software-scanner' && (d.metadata?.namespace ?? REL) === REL);
  const jobCreate = grants('batch', 'jobs', 'create');
  if (jobCreate.length && !c.zot && !scannerHere) problems.push(`${c.label}: os-ui may create Jobs in the release namespace with neither the registry nor the scanner here — ${jobCreate[0].via}`);
  for (const verb of ['update', 'patch']) {
    const rs = grants('batch', 'jobs', verb);
    if (rs.length) problems.push(`${c.label}: os-ui may ${verb} Jobs in the release namespace — ${rs[0].via}`);
  }
  // 5. The admission policy.
  const vap = docs.find((d) => d.kind === 'ValidatingAdmissionPolicy' && d.metadata?.name === POLICY);
  const vapb = docs.find((d) => d.kind === 'ValidatingAdmissionPolicyBinding' && d.metadata?.name === POLICY);
  if (!vap || !vapb) {
    problems.push(`${c.label}: the ${POLICY} admission policy/binding is not rendered`);
    continue;
  }
  if (vap.spec?.failurePolicy !== 'Fail') problems.push(`${c.label}: ${POLICY} failurePolicy is not Fail`);
  if (JSON.stringify(vapb.spec?.validationActions) !== '["Deny"]') problems.push(`${c.label}: ${POLICY} binding is not Deny`);
  if (vapb.spec?.policyName !== POLICY) problems.push(`${c.label}: the binding names another policy`);
  for (const sel of [vap.spec?.matchConstraints?.namespaceSelector, vapb.spec?.matchResources?.namespaceSelector]) {
    if (sel?.matchLabels?.['kubernetes.io/metadata.name'] !== REL) problems.push(`${c.label}: ${POLICY} does not select the release namespace`);
  }
  const ident = (vap.spec?.matchConditions ?? []).map((m) => m.expression).join(' ');
  for (const sa of SUBJECTS) if (!ident.includes(`system:serviceaccount:${REL}:${sa}"`)) problems.push(`${c.label}: ${POLICY} does not match ${sa}`);
  const rr = JSON.stringify(vap.spec?.matchConstraints?.resourceRules ?? []);
  for (const res of ['pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'cronjobs']) if (!rr.includes(`"${res}"`)) problems.push(`${c.label}: ${POLICY} does not match ${res}`);
  const exprs = (vap.spec?.validations ?? []).map((v) => v.expression).join('\n');
  if (secretWrites && !(rr.includes('"secrets"') && exprs.includes("startsWith('trino-ext-')") && exprs.includes("== 'Opaque'"))) {
    problems.push(`${c.label}: os-ui may create/update Secrets but ${POLICY} does not fence them to Opaque trino-ext-*`);
  }
  if (exprs.includes("os-scan-") !== scannerHere) problems.push(`${c.label}: ${POLICY} ${scannerHere ? 'lacks' : 'admits'} the scan Job shape while the scanner's Role is ${scannerHere ? '' : 'NOT '}in the release namespace`);
  if (exprs.includes("'zot-users'") !== Boolean(c.zot)) problems.push(`${c.label}: ${POLICY} ${c.zot ? 'lacks' : 'admits'} the zot-users Job shape`);
}

// 6. Dev: the CI account updates/deletes admission policies by name only.
const ci = yaml.loadAll(readFileSync(CI_RBAC, 'utf8')).filter(Boolean);
const named = (ci.find((d) => d.kind === 'ClusterRole' && d.metadata?.name === 'sovereign-os-ci-cluster')?.rules ?? [])
  .filter((r) => (r.resources ?? []).includes('validatingadmissionpolicies') && (r.verbs ?? []).includes('update'))
  .flatMap((r) => r.resourceNames ?? []);
if (!named.includes(POLICY)) problems.push(`scripts/dev/manifests/ci-rbac.yaml: the dev CI account cannot update ${POLICY} (add it to the named admission policies; operator re-applies)`);

if (problems.length) {
  console.error(`${NAME} FAILED:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `${NAME}: ok — in ${CASES.length} value sets os-ui writes no platform workload object but the trino Deployment (patch, external connectors on), ` +
    `scales only the toggleable components through /scale, writes no Pod and execs into none, and every create is fenced by ${POLICY} (Deny, Fail)`,
);
