#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test - App Builder build platform (workstream C1): env namespaces, registry, build steps.
 * USER STORY: As the owner I want the chart itself to refuse an exposed registry, prove both app namespaces are
 *             locked down (restricted, policies bound, default-deny, DNS on 53 AND 8053, app ingress only from the
 *             ingress controller and os-ui), that the build pod runs in a user namespace at low priority with no
 *             privilege and no registry credential, and that with the flag off nothing of this renders at all.
 * ARCHITECTURE: renders the chart with helm (spec 15 "Chart checks"):
 *   - flag OFF (default): none of software-apps-envs.yaml / software-registry.yaml renders; the Pipeline has no
 *     build task, no `criteria` result; no soa-build-low PriorityClass; the os-ui env has no SOFTWARE_APP_* key;
 *   - flag ON (+ tekton, registry host, source ranges, builder image): every property below;
 *   - negative twins: no allowedSourceRanges, 0.0.0.0/0, seccomp Unconfined, no builder image => the render FAILS.
 *   Skips loudly without helm or subchart tarballs; in CI (`process.env.CI`) a skip is a FAILURE.
 *   Run by scripts/check-software-tekton-chart.mjs (and so by os-ui/scripts/gate.sh).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CHART = join(repo, 'charts', 'sovereign-agentic-os');
// The chart refuses any builder digest not on files/builder-digests.txt (gated builds only). The test renders a COPY
// whose list holds one test digest; the real list is checked separately (no test digest ever enters it).
const TEST_DIGEST = 'sha256:' + 'a'.repeat(64);
const tmpRoot = mkdtempSync(join(tmpdir(), 'c1-chart-'));
const CHART = join(tmpRoot, 'sovereign-agentic-os');
cpSync(REAL_CHART, CHART, { recursive: true });
appendFileSync(join(CHART, 'files', 'builder-digests.txt'), `${TEST_DIGEST} builder-vtest 0\n`);
process.on('exit', () => rmSync(tmpRoot, { recursive: true, force: true }));
const require = createRequire(resolve(repo, 'os-ui/package.json'));
const yaml = require('js-yaml');
const problems = [];
const T = {
  envs: 'templates/base/os-ui/software-apps-envs.yaml', reg: 'templates/base/os-ui/software-registry.yaml',
  tk: 'templates/base/os-ui/software-tekton.yaml', pc: 'templates/base/priority-classes.yaml', osui: 'templates/base/os-ui/os-ui.yaml',
};
const BASE = ['--set', 'osUI.enabled=true', '--set', 'osUI.software.tekton.enabled=true', '--set', 'networkPolicies.apiserver.cidrs={10.96.0.1/32}', '--set', 'egressProxy.enabled=true'];
const ON = [...BASE, '--set', 'softwareRunner.environments.enabled=true', '--set', 'osUI.software.registry.host=registry.dev.example.com',
  '--set', 'osUI.software.registry.allowedSourceRanges={203.0.113.7/32}', '--set', `softwareRunner.environments.build.image=ghcr.io/example/builder@${TEST_DIGEST}`,
  '--set', 'softwareRunner.environments.build.isolation=dedicated-nodes'];

function render(extra, only) {
  return execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation', ...extra, ...only.flatMap((t) => ['--show-only', t])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryRender(extra, only) {
  try { return { out: render(extra, only), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; }
}
const helmOk = (() => { try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const depsOk = existsSync(join(REAL_CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
if (!helmOk || !depsOk) {
  const msg = `check-software-apps-envs-chart: ${helmOk ? 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)' : 'helm not on PATH'} - SKIPPED`;
  if (process.env.CI) { console.error(msg); process.exit(1); }
  console.warn(msg); process.exit(0);
}

// ── flag OFF: nothing renders ────────────────────────────────────────────────────────────────
for (const t of [T.envs, T.reg]) {
  const r = tryRender(BASE, [t]);
  if (r.out.replace(/#[^\n]*|---|\s/g, '') || (r.err && !/could not find template/.test(r.err))) problems.push(`flag off: ${t} renders something (${(r.out || r.err).slice(0, 120)})`);
}
{
  const off = yaml.loadAll(render(BASE, [T.tk, T.pc])).filter(Boolean);
  const pipe = off.find((d) => d.kind === 'Pipeline');
  if ((pipe?.spec?.tasks ?? []).some((t) => ['build-image', 'push-image', 'scan-image'].includes(t.name))) problems.push('flag off: the Pipeline has build tasks');
  if (pipe?.spec?.results || JSON.stringify(pipe).includes('CRITERIA_RESULT_PATH')) problems.push('flag off: the Pipeline carries App Builder results or CRITERIA_RESULT_PATH');
  if (off.some((d) => d.kind === 'PriorityClass' && d.metadata?.name === 'soa-build-low')) problems.push('flag off: soa-build-low renders');
  if (off.some((d) => ['buildkit-build', 'crane-push'].includes(d.metadata?.name))) problems.push('flag off: the build Tasks render');
  const osui = render(BASE, [T.osui]);
  if (/SOFTWARE_APP_REGISTRY|SOFTWARE_APPS_DEV_NAMESPACE|SOFTWARE_APP_BUILDER/.test(osui)) problems.push('flag off: os-ui env carries an App Builder key');
}

// ── flag ON ──────────────────────────────────────────────────────────────────────────────────
let docs = [];
try { docs = yaml.loadAll(render(ON, [T.envs, T.reg, T.tk, T.pc, T.osui])).filter(Boolean); } catch (e) { problems.push(`flag on: render failed: ${String(e.stderr || e.message).slice(0, 400)}`); }
const find = (kind, name, ns) => docs.find((d) => d.kind === kind && d.metadata?.name === name && (!ns || d.metadata?.namespace === ns));
if (docs.length) {
  for (const ns of ['apps-dev', 'apps-prod']) {
    const n = find('Namespace', ns);
    if (n?.metadata?.labels?.['pod-security.kubernetes.io/enforce'] !== 'restricted') problems.push(`${ns}: Pod Security restricted not enforced`);
    const deny = find('NetworkPolicy', 'app-env-default-deny', ns);
    if (!deny || JSON.stringify(deny.spec.policyTypes) !== '["Ingress","Egress"]' || Object.keys(deny.spec.podSelector).length) problems.push(`${ns}: no default-deny`);
    const dns = JSON.stringify(find('NetworkPolicy', 'app-env-allow-dns', ns)?.spec ?? {});
    for (const p of ['"port":53', '"port":8053']) if (!dns.includes(p)) problems.push(`${ns}: DNS policy lacks ${p} (SKE CoreDNS listens on 8053)`);
    const ing = find('NetworkPolicy', 'app-env-allow-ingress', ns)?.spec;
    const from = ing?.ingress?.[0]?.from ?? [];
    if ((ing?.ingress ?? []).length !== 1 || from.length !== 2 || !from.some((f) => f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'ingress-nginx' && !f.podSelector)
      || !from.some((f) => f.podSelector?.matchLabels?.['app.kubernetes.io/component'] === 'os-ui') || JSON.stringify(ing.ingress[0].ports) !== '[{"protocol":"TCP","port":8080}]') problems.push(`${ns}: app ingress must be 8080 from ingress-nginx and os-ui only`);
    if (!find('ResourceQuota', 'app-env', ns)?.spec?.hard?.pods) problems.push(`${ns}: no ResourceQuota`);
    const env = ns === 'apps-dev' ? 'dev' : 'prod';
    for (const b of [`sovereign-os-app-env-${env}-objects`, `sovereign-os-app-env-${env}-pods-dry-run-only`]) {
      const bind = find('ValidatingAdmissionPolicyBinding', b);
      if (bind?.spec?.matchResources?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] !== ns || !find('ValidatingAdmissionPolicy', b)) problems.push(`${ns}: admission policy ${b} not bound`);
    }
    const role = find('Role', 'os-ui-app-env', ns);
    if (!role || (role.rules ?? []).some((r) => r.resources?.includes('secrets') || r.verbs?.includes('*'))) problems.push(`${ns}: os-ui Role missing, or touches secrets / wildcard`);
  }
  const allow = find('ValidatingAdmissionPolicy', 'app-env-ingress-allowlist');
  if (!JSON.stringify(allow ?? {}).includes('apps-dev') || !JSON.stringify(allow ?? {}).includes('apps-prod')) problems.push('the Ingress allow-list does not cover both env namespaces');

  // registry
  if (find('Service', 'zot')?.spec?.type !== 'ClusterIP') problems.push('Zot Service must be ClusterIP (exposure ingress-restricted)');
  const zi = find('Ingress', 'zot');
  if (zi?.metadata?.annotations?.['nginx.ingress.kubernetes.io/whitelist-source-range'] !== '203.0.113.7/32') problems.push('Zot Ingress lacks the source-range allowlist');
  if (!zi?.spec?.tls?.length) problems.push('Zot Ingress has no TLS');
  const zd = find('Deployment', 'zot');
  if (!zd?.spec?.template?.spec?.containers?.[0]?.image?.includes('@sha256:')) problems.push('Zot image not pinned by digest');
  const zotNp = find('NetworkPolicy', 'zot')?.spec;
  if (JSON.stringify(zotNp?.egress ?? []).includes('0.0.0.0/0') || !JSON.stringify(zotNp?.egress ?? []).includes('egress-proxy')) problems.push('Zot egress must be DNS + egress proxy only');
  if (!find('CronJob', 'zot-users')) problems.push('no zot-users reconcile CronJob');
  const cfg = JSON.parse(find('ConfigMap', 'zot-config-template')?.data?.['config.json'] ?? '{}');
  if (!cfg.extensions?.sync?.registries?.[0]?.onDemand) problems.push('Zot mirror is not on-demand sync');
  if (JSON.stringify(cfg.http?.accessControl ?? {}).includes('apps/')) problems.push('the config template grants apps/ (zot-users owns per-domain grants)');

  // build steps
  const pipe = find('Pipeline', 'app-checks');
  const names = (pipe?.spec?.tasks ?? []).map((t) => t.name);
  for (const t of ['build-image', 'push-image', 'scan-image']) if (!names.includes(t)) problems.push(`Pipeline lacks ${t}`);
  const res = (pipe?.spec?.results ?? []).map((r) => r.name);
  if (!res.includes('criteria') || !res.includes('digest')) problems.push('Pipeline results must include criteria and digest');
  const gates = pipe?.spec?.tasks?.find((t) => t.name === 'gates');
  if (!(gates?.taskSpec?.steps ?? []).find((s) => s.name === 'tests')?.env?.some((e) => e.name === 'CRITERIA_RESULT_PATH')) problems.push('tests step lacks CRITERIA_RESULT_PATH');
  const build = pipe?.spec?.tasks?.find((t) => t.name === 'build-image');
  if (!JSON.stringify(build?.runAfter ?? []).includes('gates') || !JSON.stringify(build?.runAfter ?? []).includes('scan')) problems.push('build-image must run after gates and the tree scan');
  if (!JSON.stringify(build?.when ?? []).includes('storiesOnly')) problems.push('build-image must skip stories-only commits');
  // The `source` workspace is ReadWriteOnce and Tekton's Affinity Assistant is off (scripts/tekton/install.sh): any two
  // tasks that mount it must be ordered (transitively through runAfter), or they could run on two nodes at once and wait
  // on a Multi-Attach (the build-image pod runs on the dedicated build pool). The one parallel pair is gates + scan (a
  // failing gate must still report the scan), and only with scan's pod affinity to this run's gates pod.
  {
    const tasks = pipe?.spec?.tasks ?? [];
    const after = (name, seen = new Set()) => { for (const p of tasks.find((t) => t.name === name)?.runAfter ?? []) if (!seen.has(p)) { seen.add(p); after(p, seen); } return seen; };
    const users = tasks.filter((t) => (t.workspaces ?? []).some((w) => w.workspace === 'source')).map((t) => t.name);
    const trs = find('TriggerTemplate', 'app-checks')?.spec?.resourcetemplates?.[0]?.spec?.taskRunSpecs;
    const scanAff = JSON.stringify(trs?.find((s) => s.pipelineTaskName === 'scan')?.podTemplate?.affinity?.podAffinity ?? {});
    const coLocated = scanAff.includes('"tekton.dev/pipelineTask":"gates"') && scanAff.includes('$(tt.params.sha)') && scanAff.includes('kubernetes.io/hostname');
    for (const a of users) for (const b of users) {
      if (a >= b || after(a).has(b) || after(b).has(a)) continue;
      if (a === 'gates' && b === 'scan' && coLocated) continue;
      problems.push(`tasks ${a} and ${b} share the ReadWriteOnce source workspace but may run in parallel${a === 'gates' && b === 'scan' ? ' (scan lacks its pod affinity to the gates pod)' : ''}`);
    }
  }
  const bk = find('Task', 'buildkit-build');
  const bkj = JSON.stringify(bk ?? {});
  if (/"secret"|privileged"?:\s*true|Unconfined|SYS_ADMIN|"add"/.test(bkj)) problems.push('the build Task mounts a Secret, is privileged, Unconfined or adds a capability');
  if (!bkj.includes('--oci-worker-net=host') || !bkj.includes('rootlesskit')) problems.push('buildkitd must run under rootlesskit on the pod network');
  const cp = find('Task', 'crane-push');
  if (!JSON.stringify(cp?.spec?.volumes ?? []).includes('$(params.pushSecret)')) problems.push('crane-push must mount the push Secret');
  const others = docs.filter((d) => d.kind === 'Task' && d.metadata?.name !== 'crane-push');
  if (others.some((t) => JSON.stringify(t).includes('pushSecret'))) problems.push('a Task other than crane-push names the push Secret');
  if (JSON.stringify(pipe?.spec?.tasks?.find((t) => t.name === 'scan-image') ?? {}).includes('pushSecret')) problems.push('scan-image must not see the push credential');
  const tt = find('TriggerTemplate', 'app-checks')?.spec?.resourcetemplates?.[0]?.spec;
  const spec = tt?.taskRunSpecs?.find((s) => s.pipelineTaskName === 'build-image')?.podTemplate;
  if (spec?.hostUsers !== false) problems.push('the build pod must set hostUsers: false');
  // dedicated-nodes: the build-image pod runs at soa-build-pool (not expendable for a cluster autoscaler, cutoff -10,
  // so a Pending build scales the build pool up); every other run pod stays at soa-build-low on the shared nodes.
  if (spec?.priorityClassName !== 'soa-build-pool' || tt?.taskRunTemplate?.podTemplate?.priorityClassName !== 'soa-build-low') problems.push('the build-image pod must run at soa-build-pool on the dedicated pool, every other run pod at soa-build-low');
  const ppc = find('PriorityClass', 'soa-build-pool');
  if (!ppc || ppc.preemptionPolicy !== 'Never' || ppc.value < -10 || ppc.value >= 0) problems.push('soa-build-pool must be -10..-1 (not expendable for the cluster autoscaler) and never preempt');
  if (spec?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' || spec?.securityContext?.appArmorProfile) problems.push('build pod seccomp must be RuntimeDefault by default, no AppArmor field');
  const pc = find('PriorityClass', 'soa-build-low');
  if (!pc || pc.preemptionPolicy !== 'Never' || pc.value >= -100) problems.push('soa-build-low must be below user apps and never preempt');
  const el = find('EventListener', 'app-checks');
  const filter = el?.spec?.triggers?.[0]?.interceptors?.[0]?.params?.find((p) => p.name === 'filter')?.value ?? '';
  if (!filter.includes("body.pushSecret == 'zot-push-' + body.imageRepo.split('/')[1]")) problems.push('the listener must bind pushSecret to the repository domain');
  for (const np of ['checks-build-image-egress', 'checks-push-image-egress', 'checks-scan-image-egress']) if (!find('NetworkPolicy', np)) problems.push(`missing NetworkPolicy ${np}`);
  if (JSON.stringify(find('NetworkPolicy', 'checks-push-image-egress')?.spec?.egress ?? []).match(/ipBlock|egress-proxy/)) problems.push('the push pod may reach Zot only');
  const env = JSON.stringify(find('Deployment', 'os-ui')?.spec?.template?.spec?.containers?.[0]?.env ?? []);
  for (const k of ['SOFTWARE_APPS_DEV_NAMESPACE', 'SOFTWARE_APPS_PROD_NAMESPACE', 'SOFTWARE_APP_REGISTRY', 'SOFTWARE_APP_REGISTRY_PULL']) if (!env.includes(k)) problems.push(`flag on: os-ui env lacks ${k}`);
  // HIGH-1: the build pod is refused by the API server without its own user namespace, and refuses itself
  const vap = find('ValidatingAdmissionPolicy', 'app-checks-build-pod');
  const vexp = JSON.stringify(vap?.spec?.validations ?? []);
  if (!vexp.includes('object.spec.hostUsers == false') || !vexp.includes('Unconfined') || !vexp.includes('soa.dev/pool')) problems.push('the build-pod admission policy must require hostUsers false, forbid Unconfined and require the isolation');
  if (find('ValidatingAdmissionPolicyBinding', 'app-checks-build-pod')?.spec?.validationActions?.[0] !== 'Deny') problems.push('the build-pod admission policy is not bound (Deny)');
  for (const f of ['containers', 'initContainers', 'ephemeralContainers']) {
    for (const what of ['Unconfined', 'c.securityContext.privileged', 'capabilities.add']) {
      if (!(vap?.spec?.validations ?? []).some((v) => v.expression.includes(`object.spec.${f}`) && v.expression.includes(what))) problems.push(`the build-pod admission policy must check ${what} in ${f}`);
    }
  }
  if (!JSON.stringify(vap?.spec?.matchConstraints?.resourceRules ?? []).includes('pods/ephemeralcontainers')) problems.push('the build-pod admission policy must also match pods/ephemeralcontainers');
  if (!JSON.stringify(vap?.spec?.matchConstraints ?? {}).includes('agentic-build')) problems.push('the build-pod admission policy must match the build namespace');
  const side = bk?.spec?.sidecars?.[0];
  if (side?.command?.[0] !== '/usr/local/bin/require-userns' || side?.args?.[1] !== '/usr/local/bin/rootlesskit') problems.push('buildkitd must start through require-userns (refuses the initial user namespace)');
  // HIGH-2: isolation rendered on the build pod
  if (spec?.nodeSelector?.['soa.dev/pool'] !== 'build' || !JSON.stringify(spec?.tolerations ?? []).includes('soa.dev/build')) problems.push('isolation dedicated-nodes must render nodeSelector + tolerations on the build pod');
  {
    const sb = yaml.loadAll(render([...ON, '--set', 'softwareRunner.environments.build.isolation=sandbox-runtime', '--set', 'softwareRunner.environments.build.sandboxRuntime.runtimeClassName=gvisor'], [T.tk])).filter(Boolean);
    const sp = sb.find((d) => d.kind === 'TriggerTemplate')?.spec?.resourcetemplates?.[0]?.spec?.taskRunSpecs?.[0]?.podTemplate;
    const sv = JSON.stringify(sb.find((d) => d.kind === 'ValidatingAdmissionPolicy')?.spec?.validations ?? []);
    if (sp?.runtimeClassName !== 'gvisor' || !sv.includes('runtimeClassName')) problems.push('isolation sandbox-runtime must render and enforce runtimeClassName');
    // a sandboxed build shares nodes with the platform: it stays at soa-build-low, and no pool class renders
    if (sp?.priorityClassName !== 'soa-build-low') problems.push('isolation sandbox-runtime: the build pod must stay at soa-build-low');
    if (/name: soa-build-pool/.test(render([...ON, '--set', 'softwareRunner.environments.build.isolation=sandbox-runtime', '--set', 'softwareRunner.environments.build.sandboxRuntime.runtimeClassName=gvisor'], [T.pc]))) problems.push('isolation sandbox-runtime must not render soa-build-pool');
  }
  // LOW-6: the push pod verifies the layout before crane reads it
  if (cp?.spec?.steps?.[0]?.name !== 'verify-layout' || !/! -type f ! -type d/.test(cp?.spec?.steps?.[0]?.script ?? '')) problems.push('crane-push must refuse symlinks/special files before pushing');
  // LOW-7: zot-users egress = API server addresses, Zot and DNS only
  const zu = JSON.stringify(find('NetworkPolicy', 'zot-users')?.spec?.egress ?? []);
  if (!zu.includes('10.96.0.1/32') || zu.includes('0.0.0.0/0') || /"to":\[\]|^\[\{"ports"/.test(zu)) problems.push('zot-users egress must be the API server addresses (plus Zot, DNS) only');
  // LOW-8: soa-build-low exists whenever run pods reference it, also with priorityClasses.enabled=false
  {
    const pcOff = tryRender([...ON, '--set', 'priorityClasses.enabled=false'], [T.pc]);
    if (!/name: soa-build-low/.test(pcOff.out)) problems.push('soa-build-low must render whenever builds are configured, even with priorityClasses.enabled=false');
  }
  // LOW-10: retention keeps release-* and keep-* tags
  if (!JSON.stringify(cfg.storage?.retention ?? {}).includes('keep-.*') || !JSON.stringify(cfg.storage?.retention ?? {}).includes('release-.*')) problems.push('Zot retention must keep release-* and keep-* tags');
  // localhost fallback renders the Localhost profile path
  const lh = yaml.loadAll(render([...ON, '--set', 'softwareRunner.environments.build.seccomp=localhost'], [T.tk])).filter(Boolean);
  const lhSpec = lh.find((d) => d.kind === 'TriggerTemplate')?.spec?.resourcetemplates?.[0]?.spec?.taskRunSpecs?.[0]?.podTemplate?.securityContext?.seccompProfile;
  if (lhSpec?.type !== 'Localhost' || lhSpec?.localhostProfile !== 'operator/buildkit-rootless.json') problems.push('seccomp=localhost must render the SPO profile path');
  // H (dev): createNamespaces=false renders no Namespace (operator-owned with the same labels) and everything else in
  // the env namespaces exactly as before.
  const noNs = yaml.loadAll(render([...ON, '--set', 'softwareRunner.environments.createNamespaces=false'], [T.envs])).filter(Boolean);
  const envsOnly = yaml.loadAll(render(ON, [T.envs])).filter(Boolean);
  const withNs = envsOnly.filter((d) => d.kind !== 'Namespace');
  if (noNs.length !== withNs.length) problems.push(`createNamespaces=false must change only the 2 Namespaces (${envsOnly.length} -> ${noNs.length} objects)`);
  if (noNs.some((d) => d.kind === 'Namespace')) problems.push('createNamespaces=false must render no Namespace');
  const keyOf = (d) => `${d.kind}/${d.metadata?.namespace ?? ''}/${d.metadata?.name}`;
  for (const d of withNs) if (!noNs.some((n) => keyOf(n) === keyOf(d))) problems.push(`createNamespaces=false dropped ${keyOf(d)}`);
  if (!docs.some((d) => d.kind === 'Namespace' && d.metadata?.name === 'apps-dev')) problems.push('the default (createNamespaces true) must render the apps-dev Namespace');
}

// ── negative twins: the render refuses ──────────────────────────────────────────────────────
const twins = [
  ['no allowedSourceRanges', (() => { const a = [...ON]; const i = a.findIndex((x) => x.startsWith('osUI.software.registry.allowedSourceRanges')); a.splice(i - 1, 2); return a; })(), T.reg],
  ['0.0.0.0/0', [...ON, '--set', 'osUI.software.registry.allowedSourceRanges={0.0.0.0/0}'], T.reg],
  ['seccomp Unconfined', [...ON, '--set', 'softwareRunner.environments.build.seccomp=unconfined'], T.tk],
  ['no isolation', [...ON, '--set', 'softwareRunner.environments.build.isolation='], T.tk],
  ['seccomp localhost without isolation', [...ON, '--set', 'softwareRunner.environments.build.isolation=', '--set', 'softwareRunner.environments.build.seccomp=localhost'], T.tk],
  ['unknown isolation', [...ON, '--set', 'softwareRunner.environments.build.isolation=dev-only'], T.tk],
  ['sandbox-runtime without a RuntimeClass', [...ON, '--set', 'softwareRunner.environments.build.isolation=sandbox-runtime'], T.tk],
  ['builder digest not on the gated list', [...ON, '--set', `softwareRunner.environments.build.image=ghcr.io/example/builder@sha256:${'b'.repeat(64)}`], T.tk],
  ['builder image by tag', [...ON, '--set', 'softwareRunner.environments.build.image=ghcr.io/example/builder:latest'], T.tk],
  ['build pool class below the autoscaler cutoff', [...ON, '--set', 'softwareRunner.environments.build.dedicatedNodes.priorityClass.value=-200'], T.tk],
  ['build pool class at 0 (ranks with platform pods)', [...ON, '--set', 'softwareRunner.environments.build.dedicatedNodes.priorityClass.value=0'], T.tk],
  ['ingress-restricted with another ingress class', [...ON, '--set', 'ingress.className=traefik'], T.reg],
  ['internal-lb without the provider annotation', [...ON, '--set', 'osUI.software.registry.exposure=internal-lb'], T.reg],
  ['internal-lb without source ranges', (() => { const a = [...ON, '--set', 'osUI.software.registry.exposure=internal-lb', '--set', 'osUI.software.registry.internalLoadBalancer.annotations.networking\\.gke\\.io/load-balancer-type=Internal']; const i = a.findIndex((x) => x.startsWith('osUI.software.registry.allowedSourceRanges')); a.splice(i - 1, 2); return a; })(), T.reg],
];
// internal-lb with ranges and the annotation renders loadBalancerSourceRanges
{
  const lb = tryRender([...ON, '--set', 'osUI.software.registry.exposure=internal-lb', '--set', 'osUI.software.registry.internalLoadBalancer.annotations.networking\\.gke\\.io/load-balancer-type=Internal'], [T.reg]);
  const svc = lb.err ? null : yaml.loadAll(lb.out).filter(Boolean).find((d) => d.kind === 'Service' && d.metadata?.name === 'zot');
  if (svc?.spec?.type !== 'LoadBalancer' || svc?.spec?.loadBalancerSourceRanges?.[0] !== '203.0.113.7/32' || !svc?.metadata?.annotations?.['networking.gke.io/load-balancer-type']) problems.push(`internal-lb must render an annotated LoadBalancer with loadBalancerSourceRanges (${lb.err.slice(0, 120)})`);
}
// The retention keeper's credential (Secret zot-keeper) is readable by the zot-users ServiceAccount only: no Role or
// ClusterRole bound to os-ui / os-ui-worker may get/list/watch Secrets in the platform namespace unless it is narrowed
// by name to Secrets other than zot-keeper (rendered over the WHOLE chart, App Builder on).
{
  let all = [];
  try { all = yaml.loadAll(execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation', ...ON], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })).filter(Boolean); } catch (e) { problems.push(`whole-chart render failed: ${String(e.stderr || e.message).slice(0, 200)}`); }
  // The dedicated build pool is tainted soa.dev/build: NOTHING of the chart but the build-image pod may tolerate it (or
  // tolerate every taint), DaemonSets aside (node agents). Otherwise a platform pod could land next to untrusted build
  // code, or pin the pool so it never scales back to zero (docs/components/app-builder-build.md).
  {
    const offenders = [];
    const walk = (node, path) => {
      if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return; }
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'tolerations' && Array.isArray(v) && v.some((t) => t?.key === 'soa.dev/build' || (!t?.key && t?.operator === 'Exists'))) offenders.push(path);
        else walk(v, `${path}.${k}`);
      }
    };
    for (const d of all) {
      if (d.kind === 'DaemonSet') continue;
      if (d.kind === 'TriggerTemplate' && d.metadata?.name === 'app-checks') {
        const c = structuredClone(d);
        for (const r of c.spec?.resourcetemplates ?? []) for (const s of r.spec?.taskRunSpecs ?? []) if (s.pipelineTaskName === 'build-image') delete s.podTemplate?.tolerations;
        walk(c, `${d.kind}/${d.metadata.name}`);
        continue;
      }
      walk(d, `${d.kind}/${d.metadata?.name}`);
    }
    for (const o of offenders) problems.push(`only the build-image pod may tolerate the build pool's taint soa.dev/build (or every taint): ${o}`);
  }
  const roles = all.filter((d) => d.kind === 'Role' || d.kind === 'ClusterRole');
  const reads = (rule) => (rule.resources ?? []).some((r) => r === 'secrets' || r === '*') && (rule.verbs ?? []).some((v) => ['get', 'list', 'watch', '*'].includes(v)) && (rule.apiGroups ?? ['']).some((g) => g === '' || g === '*');
  for (const b of all.filter((d) => d.kind === 'RoleBinding' || d.kind === 'ClusterRoleBinding')) {
    if (!(b.subjects ?? []).some((s) => s.kind === 'ServiceAccount' && ['os-ui', 'os-ui-worker'].includes(s.name))) continue;
    if (b.kind === 'RoleBinding' && b.metadata?.namespace !== 'agentic-os') continue;
    const r = roles.find((x) => x.kind === b.roleRef.kind && x.metadata?.name === b.roleRef.name && (x.kind === 'ClusterRole' || x.metadata?.namespace === b.metadata?.namespace));
    for (const rule of r?.rules ?? []) {
      if (reads(rule) && (!rule.resourceNames || rule.resourceNames.includes('zot-keeper'))) problems.push(`os-ui can read the keeper credential through ${b.kind} ${b.metadata?.name} -> ${r.metadata.name} (${JSON.stringify(rule)})`);
    }
  }
  const zu = roles.find((x) => x.kind === 'Role' && x.metadata?.name === 'zot-users' && x.metadata?.namespace === 'agentic-os');
  if (!(zu?.rules ?? []).some((rule) => (rule.resourceNames ?? []).includes('zot-keeper'))) problems.push('the zot-users Role must name zot-keeper');
  const osuiZot = roles.find((x) => x.metadata?.name === 'os-ui-zot-users');
  if (JSON.stringify(osuiZot?.rules ?? []).includes('zot-keeper') || !JSON.stringify(osuiZot?.rules ?? []).includes('"zot-pull"')) problems.push('os-ui may read zot-pull (the pull identity) and never zot-keeper');
  // Domain push users may not write the reserved retention tags (Zot policy condition, rendered by zot-users; the
  // config template must not pre-grant apps/ either).
  if (!readFileSync(join(repo, 'images/base/builder/zot-users/render.go'), 'utf8').includes('req.reference.startsWith("keep-") || req.reference.startsWith("release-")')) problems.push('zot-users must condition push users against keep-*/release-* tags');
  // H: the keeper applies the release-* tags recorded on app Deployments. It reads Deployments of apps-dev/apps-prod
  // (get/list, nothing else, no write anywhere) through its own Role, bound to the zot-users ServiceAccount only; the
  // Job names both env namespaces.
  for (const ns of ['apps-dev', 'apps-prod']) {
    const rt = roles.find((x) => x.kind === 'Role' && x.metadata?.name === 'zot-users-release-tags' && x.metadata?.namespace === ns);
    const want = JSON.stringify([{ apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list'] }]);
    if (JSON.stringify(rt?.rules ?? null) !== want) problems.push(`Role zot-users-release-tags in ${ns} must grant exactly get/list on deployments.apps (got ${JSON.stringify(rt?.rules ?? null)})`);
    const rb = all.find((d) => d.kind === 'RoleBinding' && d.metadata?.name === 'zot-users-release-tags' && d.metadata?.namespace === ns);
    if (rb?.roleRef?.name !== 'zot-users-release-tags' || JSON.stringify(rb?.subjects ?? []) !== JSON.stringify([{ kind: 'ServiceAccount', name: 'zot-users', namespace: 'agentic-os' }])) problems.push(`RoleBinding zot-users-release-tags in ${ns} must bind only the zot-users ServiceAccount`);
  }
  const zuJob = all.find((d) => d.kind === 'CronJob' && d.metadata?.name === 'zot-users');
  const zuEnv = Object.fromEntries((zuJob?.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]));
  if (zuEnv.APPS_DEV_NAMESPACE !== 'apps-dev' || zuEnv.APPS_PROD_NAMESPACE !== 'apps-prod') problems.push(`the zot-users keeper must name both env namespaces (APPS_DEV_NAMESPACE/APPS_PROD_NAMESPACE, got ${JSON.stringify([zuEnv.APPS_DEV_NAMESPACE, zuEnv.APPS_PROD_NAMESPACE])})`);
  if (!readFileSync(join(repo, 'images/base/builder/zot-users/release_tags.go'), 'utf8').includes('^release-(dev|prod)-r[0-9]{14}[0-9a-f]{4}$')) problems.push('the keeper must accept only release-<env>-<release id> tags');
}
// the real list never holds a test digest
if (/^sha256:a{64}\b/m.test(execFileSync('cat', [join(REAL_CHART, 'files', 'builder-digests.txt')], { encoding: 'utf8' }))) problems.push('files/builder-digests.txt holds the test digest');
// Not configured (switch on, no builder image): no registry, no build step, and os-ui gets an EMPTY registry, so every
// deploy refuses rather than guessing (config.ts).
{
  const nc = tryRender([...ON, '--set', 'softwareRunner.environments.build.image='], [T.tk, T.osui]);
  const d = nc.err ? [] : yaml.loadAll(nc.out).filter(Boolean);
  if (nc.err) problems.push(`switch on without a builder image must render (got ${nc.err.slice(0, 160)})`);
  if (d.some((x) => x.metadata?.name === 'zot' || x.metadata?.name === 'buildkit-build')) problems.push('switch on without a builder image still renders Zot or the build Task');
  const ev = d.find((x) => x.kind === 'Deployment' && x.metadata?.name === 'os-ui')?.spec?.template?.spec?.containers?.[0]?.env ?? [];
  if (ev.find((e) => e.name === 'SOFTWARE_APP_REGISTRY')?.value !== '') problems.push('switch on without a builder image must give os-ui an empty SOFTWARE_APP_REGISTRY');
}
for (const [label, args, t] of twins) {
  const r = tryRender(args, [t]);
  if (!r.err) problems.push(`negative twin "${label}": the chart rendered instead of refusing`);
}

if (problems.length) {
  console.error('check-software-apps-envs-chart: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('check-software-apps-envs-chart: ok - flag off renders nothing; env namespaces, registry exposure, build pod and push credential hold; negative twins refused');
