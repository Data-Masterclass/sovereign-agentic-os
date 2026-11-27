/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       chart (software scanner)
 * FEATURE:    The software scanner runs in its OWN namespace (templates/base/os-ui/software-scanner.yaml).
 * USER STORY: As the owner I want os-ui's right to create Jobs and read pod logs to exist only in a namespace that
 *             holds no platform Secret, fenced by an admission policy, so a Job spec can never be used to read
 *             litellm-credentials, os-ui-session or any other platform Secret through a pod log.
 * ARCHITECTURE: Renders the REAL chart with helm (default values, values.dev.yaml, and the refusals) and asserts on
 *             the parsed objects: where the Role lives, what os-ui may do in the release namespace, the env os-ui
 *             gets, the policy/binding, the NetworkPolicies and the Pod Security labels. Each refusal has its twin.
 *             The policy's behaviour on a real API server: scripts/tests/scanner-admission.kind.sh.
 * Run: node --test scripts/tests/scanner-namespace-chart.test.mjs   (needs helm + `helm dependency build`, os-ui deps)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHART = join(ROOT, 'charts', 'sovereign-agentic-os');
const yaml = createRequire(join(ROOT, 'os-ui', 'package.json'))('js-yaml');
const REL = 'agentic-os';
const SCAN = 'agentic-os-scans';

const helmOk = spawnSync('helm', ['version', '--short']).status === 0;
const depsOk = existsSync(join(CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
const skip = !helmOk || !depsOk ? 'helm or the subchart .tgz files are missing' : false;
if (skip && process.env.CI) throw new Error(`scanner-namespace-chart: ${skip} (CI must render the chart)`);

function render(...args) {
  const r = spawnSync('helm', ['template', REL, CHART, '-n', REL, '--skip-schema-validation',
    '--set', 'global.allowChartDefaultSecrets=true', '--set', 'osUI.worker.enabled=true', ...args],
  { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return { ok: r.status === 0, err: r.stderr, docs: r.status === 0 ? yaml.loadAll(r.stdout).filter(Boolean) : [] };
}
const find = (docs, kind, name, ns) => docs.find((d) => d.kind === kind && d.metadata?.name === name && (ns === undefined || d.metadata?.namespace === ns));
const envOf = (docs, deploy) => {
  const d = find(docs, 'Deployment', deploy);
  return Object.fromEntries((d?.spec.template.spec.containers[0].env ?? []).map((e) => [e.name, e.value]));
};
const OS_UI_SAS = [`system:serviceaccount:${REL}:os-ui`, `system:serviceaccount:${REL}:os-ui-worker`];
/** Rules granted to os-ui / os-ui-worker in a namespace (through every RoleBinding there). */
function grantsIn(docs, ns) {
  const roles = new Map(docs.filter((d) => d.kind === 'Role' && d.metadata.namespace === ns).map((d) => [d.metadata.name, d]));
  const out = [];
  for (const b of docs.filter((d) => d.kind === 'RoleBinding' && d.metadata.namespace === ns)) {
    const toOsUi = (b.subjects ?? []).some((s) => s.kind === 'ServiceAccount' && OS_UI_SAS.includes(`system:serviceaccount:${s.namespace}:${s.name}`));
    if (!toOsUi || b.roleRef.kind !== 'Role') continue;
    for (const r of roles.get(b.roleRef.name)?.rules ?? []) out.push({ role: b.roleRef.name, ...r });
  }
  return out;
}

test('default: the scanner lives in <release>-scans, with Pod Security restricted', { skip }, () => {
  const { ok, err, docs } = render();
  assert.ok(ok, err);
  const ns = find(docs, 'Namespace', SCAN);
  assert.ok(ns, `the chart creates ${SCAN}`);
  for (const l of ['enforce', 'audit', 'warn']) assert.equal(ns.metadata.labels[`pod-security.kubernetes.io/${l}`], 'restricted', l);
  assert.ok(find(docs, 'Role', 'os-ui-software-scanner', SCAN), 'os-ui\'s scanner Role is in the scanner namespace');
  assert.equal(find(docs, 'Role', 'os-ui-software-scanner', REL), undefined, 'and NOT in the release namespace');
  const subjects = find(docs, 'RoleBinding', 'os-ui-software-scanner', SCAN).subjects.map((s) => `${s.namespace}/${s.name}`).sort();
  assert.deepEqual(subjects, [`${REL}/os-ui`, `${REL}/os-ui-worker`]);
});

test('default: os-ui can neither create Jobs nor read pod logs in the release namespace', { skip }, () => {
  const { docs } = render();
  const g = grantsIn(docs, REL);
  const jobs = g.filter((r) => (r.apiGroups ?? []).includes('batch') && (r.resources ?? []).includes('jobs') && r.verbs.some((v) => ['create', '*'].includes(v)));
  assert.deepEqual(jobs.map((r) => r.role), [], 'no Job create for os-ui/worker in the release namespace');
  const logs = g.filter((r) => (r.resources ?? []).includes('pods/log'));
  assert.deepEqual(logs.map((r) => r.role), [], 'no pods/log for os-ui/worker in the release namespace');
  // CronJobs (agent schedules) are untouched.
  assert.ok(g.some((r) => r.role === 'os-ui' && (r.resources ?? []).includes('cronjobs') && r.verbs.includes('create')), 'agent-schedule CronJobs still work');
});

test('default: in the scanner namespace os-ui may not read Secrets', { skip }, () => {
  const { docs } = render();
  const g = grantsIn(docs, SCAN);
  const secrets = g.filter((r) => (r.resources ?? []).includes('secrets'));
  assert.equal(secrets.length, 1);
  assert.deepEqual(secrets[0].verbs, ['create', 'delete'], 'write-only payload: no get, list, watch, update, patch');
  assert.ok(!g.some((r) => (r.resources ?? []).includes('pods') && r.verbs.includes('create')), 'no pod create');
  assert.ok(!g.some((r) => (r.resources ?? []).includes('pods/exec')), 'no exec');
});

test('default: os-ui and the worker are told the dedicated namespace and the digest-pinned image the policy admits', { skip }, () => {
  const { docs } = render();
  const vap = find(docs, 'ValidatingAdmissionPolicy', `${REL}-software-scanner-shape`);
  assert.ok(vap, 'the admission policy renders');
  const pinned = vap.spec.validations.map((v) => v.expression.match(/c\.image == "([^"]+)"/)?.[1]).find(Boolean);
  assert.match(pinned, /^aquasec\/trivy:0\.58\.2@sha256:[0-9a-f]{64}$/);
  for (const d of ['os-ui', 'os-ui-worker']) {
    const env = envOf(docs, d);
    assert.equal(env.SOFTWARE_SCANNER_NAMESPACE, SCAN, `${d}: scanner namespace`);
    assert.equal(env.SOFTWARE_SCANNER_IMAGE, pinned, `${d}: the image os-ui builds the Job from is the one the policy admits`);
  }
});

test('default: the policy and its Deny binding are scoped to the scanner namespace', { skip }, () => {
  const { docs } = render();
  const vap = find(docs, 'ValidatingAdmissionPolicy', `${REL}-software-scanner-shape`);
  const bind = find(docs, 'ValidatingAdmissionPolicyBinding', `${REL}-software-scanner-shape`);
  assert.ok(bind);
  assert.equal(vap.spec.failurePolicy, 'Fail');
  assert.deepEqual(vap.spec.matchConstraints.namespaceSelector.matchLabels, { 'kubernetes.io/metadata.name': SCAN });
  assert.deepEqual(bind.spec.matchResources.namespaceSelector.matchLabels, { 'kubernetes.io/metadata.name': SCAN });
  assert.deepEqual(bind.spec.validationActions, ['Deny']);
  const res = vap.spec.matchConstraints.resourceRules.flatMap((r) => r.resources);
  for (const r of ['pods', 'secrets', 'jobs']) assert.ok(res.includes(r), r);
});

test('default: the scanner namespace is default-deny, with DNS + the DB mirror for scan pods only', { skip }, () => {
  const { docs } = render();
  const deny = find(docs, 'NetworkPolicy', 'software-scanner-default-deny', SCAN);
  assert.ok(deny);
  assert.deepEqual(deny.spec.podSelector, {});
  assert.deepEqual(deny.spec.policyTypes, ['Ingress', 'Egress']);
  const eg = find(docs, 'NetworkPolicy', 'software-scanner-egress', SCAN);
  assert.deepEqual(eg.spec.policyTypes, ['Egress']);
  assert.equal(eg.spec.egress.length, 2, 'DNS + public 443');
  const offline = render('--set', 'osUI.software.scanner.dbMode=offline').docs;
  assert.equal(find(offline, 'NetworkPolicy', 'software-scanner-egress', SCAN).spec.egress.length, 1, 'offline: DNS only');
  assert.equal(docs.filter((d) => d.kind === 'NetworkPolicy' && d.metadata.namespace === SCAN).length, 2);
});

test('the release namespace as the scanner namespace FAILS the render (twin: another name renders)', { skip }, () => {
  const bad = render('--set', `osUI.software.scanner.namespace=${REL}`);
  assert.equal(bad.ok, false);
  assert.match(bad.err, /osUI\.software\.scanner\.namespace is the release namespace/);
  const good = render('--set', 'osUI.software.scanner.namespace=software-scans');
  assert.ok(good.ok, good.err);
  assert.ok(find(good.docs, 'Role', 'os-ui-software-scanner', 'software-scans'));
  assert.equal(envOf(good.docs, 'os-ui').SOFTWARE_SCANNER_NAMESPACE, 'software-scans');
});

test('a scanner image without a digest FAILS the render', { skip }, () => {
  const bad = render('--set', 'osUI.software.scanner.image.digest=');
  assert.equal(bad.ok, false);
  assert.match(bad.err, /osUI\.software\.scanner\.image\.digest is required/);
});

test('dev values: namespace and Role are operator-owned; the policy and NetworkPolicies still render', { skip }, () => {
  const { ok, err, docs } = render('-f', join(ROOT, 'values.dev.yaml'));
  assert.ok(ok, err);
  assert.equal(find(docs, 'Namespace', SCAN), undefined, 'createNamespace: false');
  assert.equal(docs.filter((d) => ['Role', 'RoleBinding'].includes(d.kind) && d.metadata.namespace === SCAN).length, 0, 'createOsUiRoles: false');
  assert.ok(find(docs, 'ValidatingAdmissionPolicy', `${REL}-software-scanner-shape`));
  assert.ok(find(docs, 'NetworkPolicy', 'software-scanner-default-deny', SCAN));
  assert.equal(envOf(docs, 'os-ui').SOFTWARE_SCANNER_NAMESPACE, SCAN);
  assert.equal(grantsIn(docs, REL).filter((r) => (r.resources ?? []).includes('pods/log')).length, 0);
});

test('scanner off: nothing renders in or for the scanner namespace', { skip }, () => {
  const { docs } = render('--set', 'osUI.software.scanner.enabled=false');
  assert.equal(docs.filter((d) => d.metadata?.namespace === SCAN || d.metadata?.name === SCAN).length, 0);
  assert.equal(find(docs, 'ValidatingAdmissionPolicy', `${REL}-software-scanner-shape`), undefined);
  assert.equal(envOf(docs, 'os-ui').SOFTWARE_SCANNER_ENABLED, 'false');
});

test('public 443 rules (scanner, egress proxy, direct HTTPS) leave out every non-internet range and the API server', { skip }, () => {
  const { docs } = render('--set', 'networkPolicies.apiserver.cidrs={203.0.113.5/32}', '--set', 'networkPolicies.apiserver.extraCidrs={198.51.100.7/32}');
  const want = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '240.0.0.0/4', '203.0.113.5/32', '198.51.100.7/32'];
  const names = ['software-scanner-egress', 'allow-egress-proxy-internet', 'allow-direct-https-egress-os-ui'];
  for (const name of names) {
    const np = docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === name);
    assert.ok(np, name);
    const block = np.spec.egress.flatMap((r) => r.to ?? []).find((p) => p.ipBlock?.cidr === '0.0.0.0/0').ipBlock;
    assert.deepEqual([...block.except].sort(), [...want].sort(), `${name}: except list`);
  }
  // The egress proxy still reaches the public internet on 80/443 (only the non-public ranges are cut) and DNS.
  const proxy = docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'allow-egress-proxy-internet');
  assert.deepEqual(proxy.spec.egress[0].ports.map((p) => p.port), [80, 443]);
  assert.ok(proxy.spec.egress.some((r) => (r.ports ?? []).some((p) => p.port === 53)));
});

test('no fan-out: a ResourceQuota on the scanner namespace, and the policy forbids parallel/retrying/prioritised scans', { skip }, () => {
  const { docs } = render();
  const q = find(docs, 'ResourceQuota', 'software-scanner', SCAN);
  assert.ok(q, 'a ResourceQuota');
  assert.deepEqual(q.spec.hard, { pods: '3', 'count/jobs.batch': '6', secrets: '6', 'requests.cpu': '500m', 'requests.memory': '1Gi', 'limits.cpu': '3', 'limits.memory': '3Gi' });
  const exprs = find(docs, 'ValidatingAdmissionPolicy', `${REL}-software-scanner-shape`).spec.validations.map((v) => v.expression).join('\n');
  assert.match(exprs, /parallelism\.orValue\(1\) <= 1/);
  assert.match(exprs, /completions\.orValue\(1\) <= 1/);
  assert.match(exprs, /backoffLimit\.orValue\(6\) <= 1/);
  assert.match(exprs, /priorityClassName\.orValue\(''\) == ''/);
  // Dev renders it too (the CI account may create quotas there).
  assert.ok(find(render('-f', join(ROOT, 'values.dev.yaml')).docs, 'ResourceQuota', 'software-scanner', SCAN));
});

test('the scanner namespace may not be the apps runner, an app env, the build, the credential or a cluster namespace', { skip }, () => {
  for (const ns of ['agentic-apps', 'apps-dev', 'apps-prod', 'agentic-build', `${REL}-conn-secrets`, 'kube-system', 'default']) {
    const r = render('--set', `osUI.software.scanner.namespace=${ns}`);
    assert.equal(r.ok, false, ns);
    assert.match(r.err, new RegExp(`osUI\\.software\\.scanner\\.namespace ${ns} is reserved`), ns);
  }
  // Follows the configured names, not just the defaults.
  const moved = render('--set', 'softwareRunner.namespace=tenant-apps', '--set', 'osUI.software.scanner.namespace=tenant-apps');
  assert.equal(moved.ok, false);
  assert.ok(render('--set', 'osUI.software.scanner.namespace=agentic-apps', '--set', 'softwareRunner.namespace=tenant-apps').ok, 'twin: a freed name renders');
});
