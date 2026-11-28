#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: Chart test — kube-state-metrics for the Capacity card is locked down, and os-ui has no cluster-wide pod read.
// USER STORY: As the owner I want the capacity numbers to come from kube-state-metrics with the narrowest grant
//   (list/watch on pods and nodes, a strict metric allowlist, scraped by VictoriaMetrics alone), and os-ui — the
//   largest attack surface — never to hold a cluster-wide pod grant; and the dev operator's copy of the grant never
//   to drift from the chart.
// ARCHITECTURE: renders the chart (values.local.yaml) and parses it with js-yaml:
//   (1) the kube-state-metrics ClusterRole grants exactly list+watch on pods and nodes, bound only to its own SA;
//   (2) no ClusterRole bound to os-ui / os-ui-worker grants anything on pods (namespaced Roles are not cluster-wide);
//   (3) the Deployment: image pinned by digest, `--resources=pods,nodes`, `--metric-allowlist` = the values list,
//       non-root, no privilege escalation, all capabilities dropped, read-only root filesystem;
//   (4) its NetworkPolicy admits only victoria-metrics on :8080; VictoriaMetrics scrapes it (-promscrape.config);
//       os-ui gets OS_KSM_ENABLED=true;
//   (5) kubeStateMetrics.enabled=false renders none of it, no scrape flag, and OS_KSM_ENABLED=false;
//   (6) dev: values.dev.yaml (observability on) renders no ClusterRole, and scripts/dev/manifests/
//       kube-state-metrics-rbac.yaml carries exactly the rules and subject the chart would render.
//   Loud skip on a laptop without helm / subcharts, hard failure in CI.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const TAG = 'check-kube-state-metrics-chart';
const require = createRequire(resolve(repo, 'os-ui/package.json'));
const yaml = require('js-yaml');

const helmOk = (() => { try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const depsOk = existsSync(join(CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
if (!helmOk || !depsOk) {
  const msg = `${TAG}: ${helmOk ? 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)' : 'helm not on PATH'} - SKIPPED`;
  if (process.env.CI) { console.error(msg); process.exit(1); }
  console.warn(msg); process.exit(0);
}

function render(values, extra = []) {
  const out = execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation',
    '--set', 'global.allowChartDefaultSecrets=true', '-f', join(repo, values), ...extra],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return yaml.loadAll(out).filter((d) => d && d.kind);
}
const find = (docs, kind, name) => docs.find((d) => d.kind === kind && d.metadata?.name === name);
const envOf = (docs, deploy, name) => find(docs, 'Deployment', deploy)?.spec.template.spec.containers.flatMap((c) => c.env ?? []).find((e) => e.name === name)?.value;
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const problems = [];

const values = yaml.load(readFileSync(join(CHART, 'values.yaml'), 'utf8'));
const allowlist = values.observability.kubeStateMetrics.metrics;
const docs = render('values.local.yaml');

// (1) the grant
const role = find(docs, 'ClusterRole', 'agentic-os-kube-state-metrics');
if (!role) problems.push('(1) the kube-state-metrics ClusterRole does not render');
else {
  const rules = role.rules ?? [];
  const ok = rules.length === 1 && sameSet(rules[0].apiGroups, ['']) && sameSet(rules[0].resources, ['pods', 'nodes']) && sameSet(rules[0].verbs, ['list', 'watch']) && !rules[0].resourceNames;
  if (!ok) problems.push(`(1) kube-state-metrics ClusterRole must grant exactly list+watch on pods and nodes, got ${JSON.stringify(rules)}`);
}
const ksmBinding = find(docs, 'ClusterRoleBinding', 'agentic-os-kube-state-metrics');
if (!ksmBinding || JSON.stringify(ksmBinding.subjects) !== JSON.stringify([{ kind: 'ServiceAccount', name: 'kube-state-metrics', namespace: 'agentic-os' }])) {
  problems.push(`(1) the kube-state-metrics ClusterRoleBinding must bind only ServiceAccount kube-state-metrics, got ${JSON.stringify(ksmBinding?.subjects)}`);
}

// (2) os-ui holds no cluster-wide pod grant
for (const b of docs.filter((d) => d.kind === 'ClusterRoleBinding')) {
  const osui = (b.subjects ?? []).filter((s) => s.kind === 'ServiceAccount' && ['os-ui', 'os-ui-worker'].includes(s.name));
  if (!osui.length) continue;
  const cr = find(docs, 'ClusterRole', b.roleRef?.name);
  const pods = (cr?.rules ?? []).filter((r) => (r.resources ?? []).some((x) => x === 'pods' || x === '*' || x.startsWith('pods/')));
  if (pods.length) problems.push(`(2) ${osui.map((s) => s.name).join(', ')} is bound to ClusterRole ${b.roleRef?.name}, which grants ${JSON.stringify(pods)} on pods cluster-wide — os-ui must read capacity from VictoriaMetrics, never the pod API`);
}

// (3) the Deployment
const dep = find(docs, 'Deployment', 'kube-state-metrics');
if (!dep) problems.push('(3) the kube-state-metrics Deployment does not render');
else {
  const pod = dep.spec.template.spec;
  const c = pod.containers[0];
  if (pod.serviceAccountName !== 'kube-state-metrics') problems.push('(3) kube-state-metrics must run as its own ServiceAccount');
  if (!/@sha256:[0-9a-f]{64}$/.test(c.image)) problems.push(`(3) image must be pinned by digest, got ${c.image}`);
  if (!c.args.includes('--resources=pods,nodes')) problems.push('(3) --resources=pods,nodes is missing');
  const al = c.args.find((a) => a.startsWith('--metric-allowlist='));
  if (!al || !sameSet(al.slice('--metric-allowlist='.length).split(','), allowlist)) problems.push(`(3) --metric-allowlist must equal observability.kubeStateMetrics.metrics, got ${al}`);
  if (c.args.some((a) => a.startsWith('--metric-denylist') || a.startsWith('--metric-annotations-allowlist'))) problems.push('(3) no denylist (it would replace the allowlist) and no annotations');
  if (pod.securityContext?.runAsNonRoot !== true) problems.push('(3) runAsNonRoot must be true');
  const sc = c.securityContext ?? {};
  if (sc.allowPrivilegeEscalation !== false || !sameSet(sc.capabilities?.drop ?? [], ['ALL']) || sc.readOnlyRootFilesystem !== true) problems.push(`(3) container securityContext must be restricted, got ${JSON.stringify(sc)}`);
  if (!c.resources?.limits?.memory || !c.resources?.requests?.memory) problems.push('(3) requests and memory limit are required (capacity gate)');
}

// (4) network + scrape + os-ui switch
const np = find(docs, 'NetworkPolicy', 'kube-state-metrics-allow-victoria-metrics');
const npOk = np && JSON.stringify(np.spec.policyTypes) === '["Ingress"]' && np.spec.ingress?.length === 1
  && JSON.stringify(np.spec.ingress[0].from) === JSON.stringify([{ podSelector: { matchLabels: { 'app.kubernetes.io/component': 'victoria-metrics' } } }])
  && JSON.stringify(np.spec.ingress[0].ports) === JSON.stringify([{ protocol: 'TCP', port: 8080 }]);
if (!npOk) problems.push(`(4) kube-state-metrics NetworkPolicy must admit only victoria-metrics on TCP/8080, got ${JSON.stringify(np?.spec)}`);
const vm = find(docs, 'StatefulSet', 'victoria-metrics');
if (!vm?.spec.template.spec.containers[0].args.includes('-promscrape.config=/etc/vm/scrape.yaml')) problems.push('(4) VictoriaMetrics must run with -promscrape.config=/etc/vm/scrape.yaml');
const scrape = yaml.load(find(docs, 'ConfigMap', 'victoria-metrics-scrape')?.data?.['scrape.yaml'] ?? 'null');
const targets = scrape?.scrape_configs?.flatMap((j) => j.static_configs?.flatMap((s) => s.targets) ?? []) ?? [];
if (JSON.stringify(targets) !== JSON.stringify(['kube-state-metrics.agentic-os.svc:8080'])) problems.push(`(4) the scrape config must have exactly the kube-state-metrics target, got ${JSON.stringify(targets)}`);
if (envOf(docs, 'os-ui', 'OS_KSM_ENABLED') !== 'true') problems.push(`(4) os-ui must get OS_KSM_ENABLED=true, got ${envOf(docs, 'os-ui', 'OS_KSM_ENABLED')}`);

// (5) off
const off = render('values.local.yaml', ['--set', 'observability.kubeStateMetrics.enabled=false']);
const offLeft = off.filter((d) => /kube-state-metrics/.test(d.metadata?.name ?? '') || d.metadata?.name === 'victoria-metrics-scrape');
if (offLeft.length) problems.push(`(5) kubeStateMetrics.enabled=false still renders ${offLeft.map((d) => `${d.kind}/${d.metadata.name}`).join(', ')}`);
if (find(off, 'StatefulSet', 'victoria-metrics')?.spec.template.spec.containers[0].args.some((a) => a.startsWith('-promscrape'))) problems.push('(5) VictoriaMetrics still scrapes with kube-state-metrics off');
if (envOf(off, 'os-ui', 'OS_KSM_ENABLED') !== 'false') problems.push('(5) OS_KSM_ENABLED must be "false" with kube-state-metrics off (the card then reads "not measured")');

// (6) dev: operator-owned grant, no drift
const dev = render('values.dev.yaml', ['--set', 'observability.enabled=true']);
if (dev.some((d) => d.kind === 'ClusterRole' && /kube-state-metrics/.test(d.metadata.name))) problems.push('(6) values.dev.yaml renders a kube-state-metrics ClusterRole (createClusterRole must be false on dev)');
const devWould = render('values.dev.yaml', ['--set', 'observability.enabled=true', '--set', 'observability.kubeStateMetrics.createClusterRole=true']);
const wantRole = find(devWould, 'ClusterRole', 'agentic-os-kube-state-metrics');
const wantBind = find(devWould, 'ClusterRoleBinding', 'agentic-os-kube-state-metrics');
const file = yaml.loadAll(readFileSync(join(repo, 'scripts', 'dev', 'manifests', 'kube-state-metrics-rbac.yaml'), 'utf8')).filter(Boolean);
const haveRole = file.find((d) => d.kind === 'ClusterRole');
const haveBind = file.find((d) => d.kind === 'ClusterRoleBinding');
if (!wantRole || !haveRole || JSON.stringify(haveRole.rules) !== JSON.stringify(wantRole.rules)) problems.push(`(6) scripts/dev/manifests/kube-state-metrics-rbac.yaml rules drifted from the chart: ${JSON.stringify(haveRole?.rules)} vs ${JSON.stringify(wantRole?.rules)}`);
if (!wantBind || !haveBind || JSON.stringify(haveBind.subjects) !== JSON.stringify(wantBind.subjects) || haveBind.roleRef?.name !== haveRole?.metadata?.name) problems.push('(6) scripts/dev/manifests/kube-state-metrics-rbac.yaml binding drifted from the chart (subjects or roleRef)');

if (problems.length) {
  for (const p of problems) console.error(`${TAG}: ${p}`);
  process.exit(1);
}
console.log(`${TAG}: ok — kube-state-metrics: list/watch pods+nodes only, ${allowlist.length} allowlisted families, restricted, scraped by VictoriaMetrics alone; os-ui holds no cluster-wide pod grant; the dev operator grant matches the chart`);
