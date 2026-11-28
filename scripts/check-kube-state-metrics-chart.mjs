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
//   (2) kube-state-metrics runs in its OWN namespace (Pod Security restricted), and no binding — cluster-wide, or
//       in that namespace — gives any ServiceAccount of the release namespace (os-ui, os-ui-worker, Dagster, …) or
//       a broad group (system:serviceaccounts[:<release ns>], system:authenticated) a right on pods, pods/*, jobs,
//       deployments or `*`: otherwise a compromised os-ui could run a pod as kube-state-metrics or rewrite it;
//   (3) the Deployment: image pinned by digest, `--resources=pods,nodes`, `--metric-allowlist` = the values list,
//       non-root, no privilege escalation, all capabilities dropped, read-only root filesystem;
//   (4) its namespace denies all traffic but: ingress from victoria-metrics (release namespace) on :8080, egress to
//       DNS and the API server; VictoriaMetrics has the matching egress rule and scrapes it (-promscrape.config);
//       os-ui gets OS_KSM_ENABLED=true;
//   (5) kubeStateMetrics.enabled=false renders none of it, no scrape flag, and OS_KSM_ENABLED=false;
//   (6) dev: values.dev.yaml (observability on) renders no ClusterRole and no Namespace;
//       scripts/dev/manifests/kube-state-metrics-rbac.yaml carries exactly the rules and subject the chart would
//       render, scripts/dev/manifests/namespaces.yaml the namespace with the chart's Pod Security labels, and the CI
//       deploy Role there holds no pods, pods/exec, jobs or `*` (it can still create/patch the Deployment, i.e. run a
//       pod as KSM's ServiceAccount — accepted on dev, where it already holds */*/* in agentic-os; prod deploys with
//       the admin kubeconfig);
//   (7) the API-server egress is narrowed to the given CIDRs when they are known, and the namespace guard refuses
//       every reserved namespace.
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
const REL = 'agentic-os';
const KNS = 'agentic-os-kube-state-metrics';

// (1) the grant
const role = find(docs, 'ClusterRole', 'agentic-os-kube-state-metrics');
if (!role) problems.push('(1) the kube-state-metrics ClusterRole does not render');
else {
  const rules = role.rules ?? [];
  const ok = rules.length === 1 && sameSet(rules[0].apiGroups, ['']) && sameSet(rules[0].resources, ['pods', 'nodes']) && sameSet(rules[0].verbs, ['list', 'watch']) && !rules[0].resourceNames;
  if (!ok) problems.push(`(1) kube-state-metrics ClusterRole must grant exactly list+watch on pods and nodes, got ${JSON.stringify(rules)}`);
}
const ksmBinding = find(docs, 'ClusterRoleBinding', 'agentic-os-kube-state-metrics');
if (!ksmBinding || JSON.stringify(ksmBinding.subjects) !== JSON.stringify([{ kind: 'ServiceAccount', name: 'kube-state-metrics', namespace: KNS }])) {
  problems.push(`(1) the kube-state-metrics ClusterRoleBinding must bind only ServiceAccount kube-state-metrics, got ${JSON.stringify(ksmBinding?.subjects)}`);
}

// (2) its own namespace, and nothing from the release namespace can act there
const ksmNs = find(docs, 'Namespace', KNS);
if (!ksmNs || ksmNs.metadata.labels?.['pod-security.kubernetes.io/enforce'] !== 'restricted') problems.push(`(2) namespace ${KNS} must render with pod-security.kubernetes.io/enforce=restricted`);
for (const kind of ['ServiceAccount', 'Deployment', 'Service']) {
  const o = find(docs, kind, 'kube-state-metrics');
  if (o?.metadata.namespace !== KNS) problems.push(`(2) ${kind}/kube-state-metrics must live in ${KNS}, not ${o?.metadata.namespace}`);
}
const BROAD = new Set(['system:serviceaccounts', `system:serviceaccounts:${REL}`, 'system:authenticated', 'system:unauthenticated']);
const risky = (s) => (s.kind === 'ServiceAccount' && s.namespace === REL) || (s.kind === 'Group' && BROAD.has(s.name));
const DANGER = (r) => (r.resources ?? []).filter((x) => x === '*' || x === 'pods' || x.startsWith('pods/') || x === 'jobs' || x === 'deployments' || x.startsWith('deployments/') || x === 'cronjobs');
for (const b of docs.filter((d) => d.kind === 'ClusterRoleBinding' || (d.kind === 'RoleBinding' && d.metadata?.namespace === KNS))) {
  const who = (b.subjects ?? []).filter(risky);
  if (!who.length) continue;
  const role = b.roleRef?.kind === 'ClusterRole' ? find(docs, 'ClusterRole', b.roleRef.name) : docs.find((d) => d.kind === 'Role' && d.metadata?.name === b.roleRef?.name && d.metadata?.namespace === b.metadata.namespace);
  const bad = (role?.rules ?? []).flatMap(DANGER);
  if (bad.length) problems.push(`(2) ${b.kind} ${b.metadata.name}${b.metadata.namespace ? ` in ${b.metadata.namespace}` : ' (cluster-wide)'} gives ${who.map((x) => `${x.kind}/${x.name}`).join(', ')} rights on ${[...new Set(bad)].join(', ')} — that reaches kube-state-metrics' namespace (a pod as its ServiceAccount, or a rewritten Deployment)`);
}
if (docs.some((d) => (d.kind === 'Role' || d.kind === 'RoleBinding') && d.metadata?.namespace === KNS)) problems.push(`(2) no Role or RoleBinding may render in ${KNS}`);

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
const pol = (name, ns) => docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata?.name === name && d.metadata?.namespace === ns);
const deny = pol('default-deny', KNS);
if (!deny || JSON.stringify(deny.spec.podSelector) !== '{}' || !sameSet(deny.spec.policyTypes ?? [], ['Ingress', 'Egress']) || deny.spec.ingress || deny.spec.egress) problems.push(`(4) ${KNS} must have default-deny (Ingress + Egress) for every pod`);
const inPol = pol('kube-state-metrics-allow-victoria-metrics', KNS);
const inOk = inPol && JSON.stringify(inPol.spec.policyTypes) === '["Ingress"]' && inPol.spec.ingress?.length === 1
  && JSON.stringify(inPol.spec.ingress[0].from) === JSON.stringify([{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': REL } }, podSelector: { matchLabels: { 'app.kubernetes.io/component': 'victoria-metrics' } } }])
  && JSON.stringify(inPol.spec.ingress[0].ports) === JSON.stringify([{ protocol: 'TCP', port: 8080 }]);
if (!inOk) problems.push(`(4) kube-state-metrics ingress must admit only victoria-metrics of ${REL} on TCP/8080, got ${JSON.stringify(inPol?.spec)}`);
const outPol = pol('kube-state-metrics-egress', KNS);
const outPorts = (outPol?.spec.egress ?? []).flatMap((r) => (r.ports ?? []).map((p) => `${p.protocol}/${p.port}`));
if (!outPol || !sameSet(outPorts, ['UDP/53', 'TCP/53', 'UDP/8053', 'TCP/8053', 'TCP/443', 'TCP/6443']) || (outPol.spec.egress ?? []).some((r) => !r.ports)) problems.push(`(4) kube-state-metrics egress must be DNS + the API server only, got ${JSON.stringify(outPol?.spec.egress)}`);
const vmOut = pol('victoria-metrics-scrape-kube-state-metrics', REL);
if (!vmOut || JSON.stringify(vmOut.spec.egress) !== JSON.stringify([{ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': KNS } }, podSelector: { matchLabels: { 'app.kubernetes.io/component': 'kube-state-metrics' } } }], ports: [{ protocol: 'TCP', port: 8080 }] }])) problems.push('(4) victoria-metrics needs exactly one egress rule to kube-state-metrics:8080 in its namespace');
const vm = find(docs, 'StatefulSet', 'victoria-metrics');
if (!vm?.spec.template.spec.containers[0].args.includes('-promscrape.config=/etc/vm/scrape.yaml')) problems.push('(4) VictoriaMetrics must run with -promscrape.config=/etc/vm/scrape.yaml');
const scrape = yaml.load(find(docs, 'ConfigMap', 'victoria-metrics-scrape')?.data?.['scrape.yaml'] ?? 'null');
const targets = scrape?.scrape_configs?.flatMap((j) => j.static_configs?.flatMap((s) => s.targets) ?? []) ?? [];
if (JSON.stringify(targets) !== JSON.stringify([`kube-state-metrics.${KNS}.svc:8080`])) problems.push(`(4) the scrape config must have exactly the kube-state-metrics target, got ${JSON.stringify(targets)}`);
if (envOf(docs, 'os-ui', 'OS_KSM_ENABLED') !== 'true') problems.push(`(4) os-ui must get OS_KSM_ENABLED=true, got ${envOf(docs, 'os-ui', 'OS_KSM_ENABLED')}`);

// (5) off
const off = render('values.local.yaml', ['--set', 'observability.kubeStateMetrics.enabled=false']);
const offLeft = off.filter((d) => /kube-state-metrics/.test(d.metadata?.name ?? '') || d.metadata?.namespace === KNS || d.metadata?.name === 'victoria-metrics-scrape');
if (offLeft.length) problems.push(`(5) kubeStateMetrics.enabled=false still renders ${offLeft.map((d) => `${d.kind}/${d.metadata.name}`).join(', ')}`);
if (find(off, 'StatefulSet', 'victoria-metrics')?.spec.template.spec.containers[0].args.some((a) => a.startsWith('-promscrape'))) problems.push('(5) VictoriaMetrics still scrapes with kube-state-metrics off');
if (envOf(off, 'os-ui', 'OS_KSM_ENABLED') !== 'false') problems.push('(5) OS_KSM_ENABLED must be "false" with kube-state-metrics off (the card then reads "not measured")');

// (6) dev: operator-owned grant, no drift
const dev = render('values.dev.yaml', ['--set', 'observability.enabled=true']);
if (dev.some((d) => d.kind === 'ClusterRole' && /kube-state-metrics/.test(d.metadata.name))) problems.push('(6) values.dev.yaml renders a kube-state-metrics ClusterRole (createClusterRole must be false on dev)');
if (dev.some((d) => d.kind === 'Namespace' && d.metadata.name === KNS)) problems.push('(6) values.dev.yaml renders the kube-state-metrics Namespace (createNamespace must be false on dev: the operator owns it)');
const nsFile = yaml.loadAll(readFileSync(join(repo, 'scripts', 'dev', 'manifests', 'namespaces.yaml'), 'utf8')).filter(Boolean).find((d) => d.kind === 'Namespace' && d.metadata.name === KNS);
const psa = (l) => Object.fromEntries(Object.entries(l ?? {}).filter(([k]) => k.startsWith('pod-security.kubernetes.io/') || k === 'soa.dev/purpose').sort());
const wantNs = find(render('values.dev.yaml', ['--set', 'observability.enabled=true', '--set', 'observability.kubeStateMetrics.createNamespace=true']), 'Namespace', KNS);
if (!nsFile || JSON.stringify(psa(nsFile.metadata.labels)) !== JSON.stringify(psa(wantNs?.metadata.labels))) problems.push(`(6) scripts/dev/manifests/namespaces.yaml must carry ${KNS} with the chart's labels ${JSON.stringify(psa(wantNs?.metadata.labels))}, got ${JSON.stringify(psa(nsFile?.metadata.labels))}`);
const ciRole = yaml.loadAll(readFileSync(join(repo, 'scripts', 'dev', 'manifests', 'ci-rbac.yaml'), 'utf8')).filter(Boolean).find((d) => d.kind === 'Role' && d.metadata.namespace === KNS);
const ciBad = (ciRole?.rules ?? []).flatMap((r) => (r.resources ?? []).filter((x) => x === '*' || x === 'pods' || x.startsWith('pods/') || x === 'jobs'));
if (!ciRole) problems.push(`(6) scripts/dev/manifests/ci-rbac.yaml has no deploy Role in ${KNS} (the CI account could not install kube-state-metrics there)`);
else if (ciBad.length) problems.push(`(6) the CI deploy Role in ${KNS} grants ${ciBad.join(', ')} — only the kinds the chart renders there (Deployment, Service, ServiceAccount, NetworkPolicy). Note the residual risk that remains even then: creating or patching the Deployment runs a pod as kube-state-metrics' ServiceAccount`);
const devWould = render('values.dev.yaml', ['--set', 'observability.enabled=true', '--set', 'observability.kubeStateMetrics.createClusterRole=true']);
const wantRole = find(devWould, 'ClusterRole', 'agentic-os-kube-state-metrics');
const wantBind = find(devWould, 'ClusterRoleBinding', 'agentic-os-kube-state-metrics');
const file = yaml.loadAll(readFileSync(join(repo, 'scripts', 'dev', 'manifests', 'kube-state-metrics-rbac.yaml'), 'utf8')).filter(Boolean);
const haveRole = file.find((d) => d.kind === 'ClusterRole');
const haveBind = file.find((d) => d.kind === 'ClusterRoleBinding');
if (!wantRole || !haveRole || JSON.stringify(haveRole.rules) !== JSON.stringify(wantRole.rules)) problems.push(`(6) scripts/dev/manifests/kube-state-metrics-rbac.yaml rules drifted from the chart: ${JSON.stringify(haveRole?.rules)} vs ${JSON.stringify(wantRole?.rules)}`);
if (!wantBind || !haveBind || JSON.stringify(haveBind.subjects) !== JSON.stringify(wantBind.subjects) || haveBind.roleRef?.name !== haveRole?.metadata?.name) problems.push('(6) scripts/dev/manifests/kube-state-metrics-rbac.yaml binding drifted from the chart (subjects or roleRef)');

// (7) narrowed API-server egress + the namespace guard
const narrowed = render('values.local.yaml', ['--set', 'networkPolicies.apiserver.cidrs={10.250.0.1/32}', '--set', 'networkPolicies.apiserver.extraCidrs={10.250.0.9/32}']);
const nOut = narrowed.find((d) => d.kind === 'NetworkPolicy' && d.metadata?.name === 'kube-state-metrics-egress' && d.metadata?.namespace === KNS);
const apiRule = (nOut?.spec.egress ?? []).find((r) => (r.ports ?? []).some((p) => p.port === 6443));
if (JSON.stringify(apiRule) !== JSON.stringify({ ports: [{ protocol: 'TCP', port: 443 }, { protocol: 'TCP', port: 6443 }], to: [{ ipBlock: { cidr: '10.250.0.1/32' } }, { ipBlock: { cidr: '10.250.0.9/32' } }] })) {
  problems.push(`(7) with networkPolicies.apiserver.cidrs/extraCidrs set, kube-state-metrics' API-server egress must be narrowed to exactly those ipBlocks, got ${JSON.stringify(apiRule)}`);
}
const refuses = (ns) => {
  try { render('values.local.yaml', ['--set', `observability.kubeStateMetrics.namespace=${ns}`]); return false; } catch { return true; }
};
for (const ns of ['agentic-os', 'agentic-apps', 'apps-dev', 'apps-prod', 'agentic-os-conn-secrets', 'agentic-build', 'agentic-os-scans', 'agentic-os-restore-drill', 'velero', 'default', 'kube-system', 'kube-public', 'kube-node-lease']) {
  if (!refuses(ns)) problems.push(`(7) observability.kubeStateMetrics.namespace=${ns} must be refused (reserved)`);
}
if (refuses('agentic-os-kube-state-metrics')) problems.push('(7) the default kube-state-metrics namespace must render');

if (problems.length) {
  for (const p of problems) console.error(`${TAG}: ${p}`);
  process.exit(1);
}
console.log(`${TAG}: ok — kube-state-metrics in its own restricted namespace ${KNS}: list/watch pods+nodes only, ${allowlist.length} allowlisted families, default-deny with VictoriaMetrics ingress + DNS/API-server egress; no release-namespace ServiceAccount or broad group can touch pods/jobs/deployments there or cluster-wide; the dev operator objects match the chart`);
