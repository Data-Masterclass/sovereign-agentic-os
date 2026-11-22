#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test - the Software Factory gates sandbox is its own, locked-down namespace
 * USER STORY: As an operator I want an app's untrusted tests to run where they cannot reach os-ui, the
 *             databases, OPA or the Kubernetes API, and to reach npm only through the egress proxy.
 * ARCHITECTURE: renders templates/base/os-ui/software-sandbox.yaml (+ the policies it must stay out of) with
 *             helm and asserts: a dedicated namespace (never the release namespace) with Pod Security
 *             `restricted`; default-deny for ingress AND egress; the only egress is DNS and the egress proxy;
 *             the RBAC Role and binding live in the SANDBOX namespace and cover Jobs, pods, pod logs and the
 *             payload Secret; the blanket allow policies in the release namespace exclude
 *             `software-gates`; the proxy accepts the sandbox as a caller and allows registry.npmjs.org.
 *             Negative twin: with the sandbox namespace set to the release namespace the render must be refused.
 *             Skips loudly without helm; in CI a skip is a failure. Wired into os-ui/scripts/gate.sh.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const require = createRequire(resolve(repo, 'os-ui/package.json'));
const yaml = require('js-yaml');
const problems = [];

const helmOk = (() => { try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const depsOk = existsSync(join(CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
if (!helmOk || !depsOk) {
  const msg = `check-software-sandbox-chart: ${helmOk ? 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)' : 'helm not on PATH'} - SKIPPED`;
  if (process.env.CI) problems.push(msg); else console.warn(msg);
} else {
  const BASE = ['--set', 'osUI.enabled=true', '--set', 'networkPolicies.defaultDeny=true', '--set', 'networkPolicies.apiserver.cidrs={10.96.0.1/32}', '--set', 'egressProxy.enabled=true'];
  const render = (only, extra = []) => execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation', ...BASE, ...extra, ...only.flatMap((t) => ['--show-only', t])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const docs = (s) => yaml.loadAll(s).filter(Boolean);
  const SANDBOX = 'templates/base/os-ui/software-sandbox.yaml';
  let sb = [];
  try { sb = docs(render([SANDBOX])); } catch (e) { problems.push(`software-sandbox.yaml does not render: ${String(e.stderr ?? e).slice(0, 300)}`); }
  const by = (kind) => sb.filter((d) => d.kind === kind);
  const ns = by('Namespace')[0];
  const nsName = ns?.metadata?.name;
  if (!ns) problems.push('no sandbox Namespace is rendered');
  else {
    if (nsName === 'agentic-os') problems.push('the sandbox namespace is the release namespace');
    if (ns.metadata.labels?.['pod-security.kubernetes.io/enforce'] !== 'restricted') problems.push('sandbox namespace does not enforce Pod Security restricted');
  }
  const np = by('NetworkPolicy');
  const deny = np.find((p) => (p.spec.podSelector ?? {}) && Object.keys(p.spec.podSelector ?? {}).length === 0 && !p.spec.egress && !p.spec.ingress && p.spec.policyTypes?.includes('Egress') && p.spec.policyTypes?.includes('Ingress'));
  if (!deny) problems.push('no default-deny (ingress + egress, empty podSelector) NetworkPolicy in the sandbox namespace');
  if (np.some((p) => p.metadata.namespace !== nsName)) problems.push('a sandbox NetworkPolicy is outside the sandbox namespace');
  const allowed = np.flatMap((p) => (p.spec.egress ?? []).flatMap((e) => (e.to ?? []).map((t) => ({ t, ports: e.ports ?? [] }))));
  for (const { t } of allowed) {
    if (t.ipBlock) problems.push(`sandbox egress to an ipBlock (${t.ipBlock.cidr}) - only DNS and the egress proxy are allowed`);
    if (t.podSelector && !t.namespaceSelector) problems.push('sandbox egress selects pods in its own namespace');
  }
  const proxyRule = allowed.find(({ t }) => t.podSelector?.matchLabels?.['app.kubernetes.io/component'] === 'egress-proxy');
  if (!proxyRule || !proxyRule.ports.some((p) => p.port === 3128)) problems.push('no egress rule to the egress proxy on 3128');
  if (proxyRule && proxyRule.t.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] !== 'agentic-os') problems.push('the proxy rule does not pin the release namespace');
  const dns = allowed.filter(({ t }) => t.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'kube-system');
  if (dns.length === 0) problems.push('no DNS egress rule');
  if (allowed.length !== (proxyRule ? 1 : 0) + dns.length) problems.push(`sandbox egress allows ${allowed.length} destinations; expected exactly DNS + the egress proxy`);
  const role = by('Role')[0];
  if (!role || role.metadata.namespace !== nsName) problems.push('the sandbox Role is not in the sandbox namespace');
  else {
    const has = (res, verb) => role.rules.some((r) => r.resources.includes(res) && r.verbs.includes(verb));
    for (const [res, verb] of [['jobs', 'create'], ['jobs', 'get'], ['jobs', 'delete'], ['jobs', 'deletecollection'], ['jobs', 'list'], ['pods', 'list'], ['pods/log', 'get'], ['secrets', 'create'], ['secrets', 'delete']]) if (!has(res, verb)) problems.push(`sandbox Role lacks ${verb} on ${res}`);
    if (role.rules.some((r) => r.resources.includes('secrets') && (r.verbs.includes('get') || r.verbs.includes('list')))) problems.push('sandbox Role can read Secrets');
  }
  const rb = by('RoleBinding')[0];
  if (!rb || rb.metadata.namespace !== nsName || rb.subjects?.[0]?.name !== 'os-ui' || rb.subjects?.[0]?.namespace !== 'agentic-os') problems.push('the sandbox RoleBinding does not bind os-ui (release namespace) in the sandbox namespace');

  // the blanket allows in the release namespace stay out of the sandbox pods
  const egress = docs(render(['templates/base/network/egress-policies.yaml']));
  for (const name of ['allow-intra-namespace-egress', 'allow-apiserver-egress']) {
    const p = egress.find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === name);
    const ex = p?.spec?.podSelector?.matchExpressions?.find((m) => m.key === 'app.kubernetes.io/component' && m.operator === 'NotIn');
    if (!p) problems.push(`policy ${name} not found`);
    else if (!ex?.values?.includes('software-gates')) problems.push(`${name} does not exclude component software-gates`);
  }
  // the proxy accepts the sandbox as a caller, and the registry is on its allowlist
  const ingress = docs(render(['templates/base/network/platform-ingress-policies.yaml']));
  const callers = ingress.find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'egress-proxy-allow-callers');
  const fromSandbox = (callers?.spec?.ingress ?? []).flatMap((i) => i.from ?? []).some((f) => f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === nsName && f.podSelector?.matchLabels?.['app.kubernetes.io/component'] === 'software-gates');
  if (!fromSandbox) problems.push('egress-proxy-allow-callers does not admit the software-gates pods from the sandbox namespace');
  const proxyCfg = docs(render(['templates/base/egress/proxy.yaml'])).find((d) => d.kind === 'ConfigMap');
  if (!/registry\\\.npmjs\\\.org/.test(proxyCfg?.data?.filter ?? '')) problems.push('registry.npmjs.org is not on the egress proxy allowlist');

  // negative twin: the release namespace is refused as the sandbox namespace
  let refused = false;
  try { render([SANDBOX], ['--set', 'osUI.software.sandbox.namespace=agentic-os']); } catch { refused = true; }
  if (!refused) problems.push('negative twin: osUI.software.sandbox.namespace=<release namespace> rendered instead of being refused');
}

if (problems.length) {
  console.error(`check-software-sandbox-chart: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('check-software-sandbox-chart: ok');
