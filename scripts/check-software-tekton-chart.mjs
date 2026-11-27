#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test - the Software Factory CI (Tekton) resources
 * USER STORY: As an operator I want the build namespace to be locked down by the chart, and to know that
 *             os-ui can read and cancel runs but cannot start an arbitrary pipeline, that the app's code
 *             reaches only the egress proxy, and that the Tekton pins are the ones that were checked.
 * ARCHITECTURE:
 *   - Static half (always runs): the vendored Catalog tasks match the sha256 in scripts/tekton/versions.env;
 *     the pins are well-formed (release URL names the version, 64-hex digests); the sandbox settings are gone.
 *   - Rendered half (needs helm + subchart tarballs): off by default (renders nothing); on, it renders the
 *     namespace (Pod Security baseline enforced, restricted audited), the listener, RBAC, quota, pruner and the default-deny network
 *     policies, and the properties above. Skips loudly without helm; in CI (`process.env.CI`) a skip is a FAILURE.
 *   - Wired into os-ui/scripts/gate.sh.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const TEMPLATES = ['templates/base/os-ui/software-tekton.yaml', 'templates/base/egress/proxy.yaml'];
const problems = [];
const require = createRequire(resolve(repo, 'os-ui/package.json'));
const yaml = require('js-yaml');

// ── static half ────────────────────────────────────────────────────────────────────────────
const pins = Object.fromEntries(
  readFileSync(join(repo, 'scripts/tekton/versions.env'), 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
for (const k of ['TEKTON_PIPELINES_SHA256', 'TEKTON_TRIGGERS_SHA256', 'TEKTON_INTERCEPTORS_SHA256', 'TEKTON_TASK_GIT_CLONE_SHA256', 'TEKTON_TASK_TRIVY_SCANNER_SHA256']) {
  if (!/^[a-f0-9]{64}$/.test(pins[k] ?? '')) problems.push(`versions.env: ${k} is not a sha256`);
}
if (!/^[a-f0-9]{40}$/.test(pins.TEKTON_CATALOG_COMMIT ?? '')) problems.push('versions.env: TEKTON_CATALOG_COMMIT is not a commit sha');
for (const [v, u] of [['TEKTON_PIPELINES_VERSION', 'TEKTON_PIPELINES_URL'], ['TEKTON_TRIGGERS_VERSION', 'TEKTON_TRIGGERS_URL']]) {
  if (!pins[u]?.includes(`/${pins[v]}/`)) problems.push(`versions.env: ${u} does not name ${v} (${pins[v]})`);
}
for (const [name, key] of [['git-clone', 'GIT_CLONE'], ['trivy-scanner', 'TRIVY_SCANNER']]) {
  const file = join(CHART, 'files/tekton/tasks', `${name}.yaml`);
  if (!existsSync(file)) { problems.push(`vendored task ${name} is missing`); continue; }
  const got = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (got !== pins[`TEKTON_TASK_${key}_SHA256`]) problems.push(`vendored task ${name}: sha256 ${got} != pinned ${pins[`TEKTON_TASK_${key}_SHA256`]} (a Catalog task is vendored byte-for-byte; update the pin with the file)`);
}
const values = yaml.load(readFileSync(join(CHART, 'values.yaml'), 'utf8'));
if (values?.osUI?.software?.tekton?.enabled !== false) problems.push('values.yaml: osUI.software.tekton.enabled must default to false (it needs Tekton installed first)');
const cfg = readFileSync(join(repo, 'os-ui/core/kernel/config.ts'), 'utf8');
if (/SOFTWARE_SANDBOX_/.test(cfg)) problems.push('config.ts still carries SOFTWARE_SANDBOX_* (the hand-made sandbox Job is retired)');
if (existsSync(join(repo, 'os-ui/tabs/software/lib/sandbox-gates.ts'))) problems.push('sandbox-gates.ts still exists (Tekton replaced the sandbox Job)');

// ── rendered half ──────────────────────────────────────────────────────────────────────────
const helmOk = (() => { try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const depsOk = existsSync(join(CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
function render(extra, only = TEMPLATES) {
  return execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation', ...extra, ...only.flatMap((t) => ['--show-only', t])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const ON = ['--set', 'osUI.enabled=true', '--set', 'osUI.software.tekton.enabled=true', '--set', 'networkPolicies.apiserver.cidrs={10.96.0.1/32}', '--set', 'egressProxy.enabled=true'];
if (!helmOk || !depsOk) {
  const msg = `check-software-tekton-chart: ${helmOk ? 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)' : 'helm not on PATH'} - rendered half SKIPPED`;
  if (process.env.CI) problems.push(msg); else console.warn(msg);
} else {
  // off by default: nothing of the CI engine renders
  let offOut = '';
  try { offOut = render([], [TEMPLATES[0]]); } catch (e) { offOut = /could not find template/.test(String(e.stderr)) ? '' : `ERR ${String(e.stderr).slice(0, 200)}`; }
  if (offOut.replace(/#[^\n]*|---|\s/g, '')) problems.push(`tekton disabled still renders: ${offOut.slice(0, 120)}`);

  let docs = [];
  try { docs = yaml.loadAll(render(ON)).filter(Boolean); } catch (e) { problems.push(`render failed: ${String(e.stderr || e.message).slice(0, 400)}`); }
  const find = (kind, name) => docs.find((d) => d.kind === kind && d.metadata?.name === name);
  if (docs.length) {
    const ns = docs.find((d) => d.kind === 'Namespace');
    if (ns?.metadata?.name !== 'agentic-build') problems.push('build namespace is not agentic-build');
    const psa = ns?.metadata?.labels ?? {};
    if (!['baseline', 'restricted'].includes(psa['pod-security.kubernetes.io/enforce'])) problems.push('build namespace does not enforce at least Pod Security baseline');
    if (psa['pod-security.kubernetes.io/audit'] !== 'restricted') problems.push('build namespace must audit against Pod Security restricted');

    // os-ui: read + cancel, never create a run
    const role = find('Role', 'os-ui-software-checks');
    const verbs = (res) => (role?.rules ?? []).filter((r) => r.resources?.includes(res)).flatMap((r) => r.verbs);
    if (!role) problems.push('os-ui Role in the build namespace is missing');
    if (verbs('pipelineruns').includes('create') || verbs('pipelineruns').includes('delete')) problems.push('os-ui must not create or delete PipelineRuns (only the listener creates them, only the pruner deletes them)');
    if (!verbs('pipelineruns').includes('patch')) problems.push('os-ui needs patch on pipelineruns to cancel a superseded run');
    if (!verbs('pods/log').includes('get')) problems.push('os-ui needs pods/log get to read step logs');
    if ((role?.rules ?? []).some((r) => r.resources?.includes('secrets') || r.verbs?.includes('*'))) problems.push('os-ui Role in the build namespace touches secrets or uses a wildcard');
    const lr = find('Role', 'app-checks-listener-runs');
    if (JSON.stringify(lr?.rules?.[0]?.verbs) !== '["create"]' || !lr?.rules?.[0]?.resources?.includes('pipelineruns')) problems.push('the listener Role must be exactly create on pipelineruns');

    // the listener validates what it is sent, with Tekton's own CEL interceptor, and the template pins the pipeline to the sha
    const el = find('EventListener', 'app-checks');
    const filter = el?.spec?.triggers?.[0]?.interceptors?.[0]?.params?.find((p) => p.name === 'filter')?.value ?? '';
    for (const need of ['body.sha.matches', 'body.slug.matches', 'body.runName.matches', 'body.trigger in', "(!has(body.templateVersion) || body.templateVersion in ['1', '2'])", "(!has(body.storiesOnly) || body.storiesOnly in ['true', 'false'])"]) if (!filter.includes(need)) problems.push(`EventListener CEL filter lacks ${need}`);
    const tt = find('TriggerTemplate', 'app-checks');
    const pr = tt?.spec?.resourcetemplates?.[0];
    const res = pr?.spec?.pipelineRef;
    // THE PIPELINE AND THE GATE FILES ARE THE PLATFORM'S, NOT THE AUTHOR'S: the run references the chart-owned
    // Pipeline by name (never a file resolved from the app's own commit), and its gate steps run the platform's
    // copy of the gates script and policy from a ConfigMap, so nothing in the pushed tree can change what judges it.
    if (res?.name !== 'app-checks' || res?.resolver) problems.push('the PipelineRun must reference the chart-owned Pipeline `app-checks` by name, never an app-owned file resolved from git');
    const pipe = find('Pipeline', 'app-checks');
    if (!pipe) problems.push('the chart does not render the Pipeline app-checks');
    const pj = JSON.stringify(pipe ?? {});
    if (/scripts\/factory-gates\.mjs/.test(pj)) problems.push('a gate step runs the app\'s own scripts/factory-gates.mjs; only /platform/gates/factory-gates.mjs may run (and nothing may name scripts/factory-gates.mjs)');
    if (pj.includes('workspaces.app.path)/policy')) problems.push('OPA loads the app\'s own policy; it must load /platform/policy');
    if (pipe && !pj.includes('/platform/policy')) problems.push('OPA does not load /platform/policy');
    // PER TEMPLATE VERSION (App Builder W0, spec 2c): `v<n>.<file>` is byte-identical to files/tekton/platform/v<n>/<file>
    // AND to that version's template (v1 = templates/nextjs-web, frozen; v2 = templates/nextjs-web-v2), and the gate
    // steps read the key of the run's `templateVersion` param, so an app is judged by the version it was created from.
    const plat = find('ConfigMap', 'app-checks-platform');
    const TEMPLATE_DIR = { v1: 'templates/nextjs-web', v2: 'templates/nextjs-web-v2' };
    for (const [v, dir] of Object.entries(TEMPLATE_DIR)) {
      for (const [file, inTemplate] of [['factory-gates.mjs', 'scripts/factory-gates.mjs'], ['app-rules.rego', 'policy/app-rules.rego']]) {
        const key = `${v}.${file}`;
        if (plat?.data?.[key] !== readFileSync(join(CHART, 'files/tekton/platform', v, file), 'utf8')) problems.push(`ConfigMap app-checks-platform: ${key} is missing or differs from files/tekton/platform/${v}/${file}`);
        if (plat?.data?.[key] !== readFileSync(join(repo, dir, inTemplate), 'utf8')) problems.push(`ConfigMap app-checks-platform: ${key} differs from ${dir}/${inTemplate}`);
      }
    }
    if (Object.keys(plat?.data ?? {}).some((k) => !/^v[12]\.(factory-gates\.mjs|app-rules\.rego)$/.test(k))) problems.push(`ConfigMap app-checks-platform carries an unversioned key (${Object.keys(plat?.data ?? {}).join(', ')})`);
    const gateVols = JSON.stringify(pipe?.spec?.tasks?.find((t) => t.name === 'gates')?.taskSpec?.volumes ?? []);
    for (const k of ['v$(params.templateVersion).factory-gates.mjs', 'v$(params.templateVersion).app-rules.rego']) if (!gateVols.includes(k)) problems.push(`the gates task does not select ${k} (the gate files must follow the run's templateVersion)`);
    if (!(pipe?.spec?.params ?? []).some((p) => p.name === 'templateVersion' && p.default === '1')) problems.push('the Pipeline lacks the templateVersion param (default "1")');
    const prParams = JSON.stringify(pr?.spec?.params ?? []);
    if (!prParams.includes('$(tt.params.templateVersion)')) problems.push('the PipelineRun does not pass templateVersion');
    // ROLLING UPGRADE: an os-ui older than W0 sends no templateVersion/storiesOnly. The binding must read the CEL
    // overlays (which default them to "1"/"false"), never the body directly, or that pod's push checks are refused.
    const overlays = el?.spec?.triggers?.[0]?.interceptors?.[0]?.params?.find((p) => p.name === 'overlays')?.value ?? [];
    const ov = (k) => overlays.find((o) => o.key === k)?.expression ?? '';
    if (!/has\(body\.templateVersion\)/.test(ov('templateVersion')) || !ov('templateVersion').includes("'1'")) problems.push('the CEL overlay must default templateVersion to "1" when the body omits it');
    if (!/has\(body\.storiesOnly\)/.test(ov('storiesOnly')) || !ov('storiesOnly').includes("'false'")) problems.push('the CEL overlay must default storiesOnly to "false" when the body omits it');
    const tb = JSON.stringify(find('TriggerBinding', 'app-checks')?.spec?.params ?? []);
    if (!tb.includes('$(extensions.templateVersion)') || !tb.includes('$(extensions.storiesOnly)') || /body\.(templateVersion|storiesOnly)/.test(tb)) problems.push('the TriggerBinding must take templateVersion/storiesOnly from the CEL overlays (extensions), not the body');
    // THE TOOLCHAIN IS THE PLATFORM'S TOO: tsc, eslint and tsx come from the pinned lockfile (ConfigMap), never from the app's node_modules.
    const tcm = find('ConfigMap', 'app-checks-toolchain');
    for (const f of ['package.json', 'package-lock.json', 'eslint.config.mjs', 'next-allowlist.json']) {
      if (tcm?.data?.[f] !== readFileSync(join(repo, 'templates/platform-toolchain', f), 'utf8')) problems.push(`ConfigMap app-checks-toolchain: ${f} is missing or differs from templates/platform-toolchain/${f}`);
    }
    const gatesTask = pipe?.spec?.tasks?.find((t) => t.name === 'gates')?.taskSpec;
    const stepNames = (gatesTask?.steps ?? []).map((st) => st.name);
    if (stepNames[0] !== 'toolchain') problems.push(`gates steps must start with toolchain (got ${stepNames.slice(0, 3).join(',')})`);
    if (!(stepNames.indexOf('facts') > 0 && stepNames.indexOf('facts') < stepNames.indexOf('policy') && stepNames.indexOf('policy') < stepNames.indexOf('install'))) problems.push(`the policy must be judged (facts, policy) before install and any step that runs the app's code (got ${stepNames.join(',')})`);
    // NO POLICY SERVER: a sidecar shares the pod's network namespace with the app's code, which could replace the policy through it.
    if ((gatesTask?.sidecars ?? []).length) problems.push('the gates pod has a sidecar: the app\'s code (tests, build) shares its network namespace; the policy is a one-shot `opa eval`');
    if (/8181|OPA_URL|--server/.test(JSON.stringify(gatesTask ?? {}))) problems.push('the gates task names an OPA server address or flag');
    const polStep = (gatesTask?.steps ?? []).find((st) => st.name === 'policy');
    if (!polStep || polStep.command?.[0] !== '/opa' || polStep.args?.[0] !== 'eval' || !polStep.args?.includes('--fail-defined')) problems.push('the policy step must run `/opa eval --fail-defined` (its exit code is the verdict)');
    for (const m of ['/platform/policy', '/facts']) if (!(polStep?.volumeMounts ?? []).some((v) => v.mountPath === m && v.readOnly === true)) problems.push(`the policy step must mount ${m} read-only`);
    if (gatesTask?.workspaces?.find((w) => w.name === 'app')?.readOnly !== true) problems.push('the app workspace (the pushed tree) must be read-only in the pod that runs the app\'s code');
    if (gatesTask?.stepTemplate?.securityContext?.readOnlyRootFilesystem !== true) problems.push('the gate steps must have a read-only root filesystem');
    for (const st of gatesTask?.steps ?? []) {
      if (['install', 'typecheck', 'lint', 'tests', 'build'].includes(st.name) && (st.volumeMounts ?? []).some((v) => ['/platform/policy', '/facts'].includes(v.mountPath))) problems.push(`step ${st.name} (the app's code) must not mount the policy or the facts`);
    }
    for (const st of gatesTask?.steps ?? []) {
      if (['typecheck', 'lint', 'tests', 'build'].includes(st.name)) {
        if (!/--toolchain \/platform\/toolchain\b/.test(st.script ?? '')) problems.push(`gate step ${st.name} does not run on the platform toolchain (--toolchain /platform/toolchain)`);
        if (/node_modules/.test(st.script ?? '')) problems.push(`gate step ${st.name} names node_modules`);
        const m = (st.volumeMounts ?? []).find((v) => v.mountPath === '/platform/toolchain');
        if (!m || m.readOnly !== true) problems.push(`gate step ${st.name} must mount the toolchain read-only`);
      }
    }
    // NEGATIVE TWIN: the pipeline file in the template (the eject copy) is not what the OS runs, and the two must not be confused
    if (res?.resolver === 'git') problems.push('negative twin: a git-resolved pipeline is back');
    if (pr?.spec?.taskRunTemplate?.podTemplate?.automountServiceAccountToken !== false) problems.push('run pods must not mount a ServiceAccount token');
    if (!pr?.spec?.timeouts?.pipeline) problems.push('PipelineRun has no timeout');
    if (find('ServiceAccount', 'app-checks')?.automountServiceAccountToken !== false) problems.push('run ServiceAccount automounts a token');

    if (!find('LimitRange', 'app-checks')?.spec?.limits?.[0]?.defaultRequest) problems.push('no LimitRange defaults: injected containers would be refused by the quota');
    // quota and pruning
    if (!find('ResourceQuota', 'app-checks')?.spec?.hard?.pods) problems.push('no pod quota in the build namespace');
    const cj = find('CronJob', 'app-checks-prune');
    if (!cj || !JSON.stringify(cj.spec.jobTemplate.spec.template.spec.containers[0].command).includes('--keep')) problems.push('no run-history pruner (tkn pipelinerun delete --keep)');

    // network: default deny, then exactly what each step needs
    const np = (n) => find('NetworkPolicy', n);
    const deny = np('checks-default-deny');
    if (!deny || JSON.stringify(deny.spec.policyTypes) !== '["Ingress","Egress"]' || Object.keys(deny.spec.podSelector).length) problems.push('build namespace lacks a default-deny (ingress and egress) policy');
    const gates = np('checks-gates-egress');
    const gatesTo = (gates?.spec?.egress ?? []).flatMap((e) => e.to ?? []);
    if (gatesTo.length !== 1 || gatesTo[0].podSelector?.matchLabels?.['app.kubernetes.io/component'] !== 'egress-proxy') problems.push('the gates pod (the app\'s code) may reach only the egress proxy');
    if ((gates?.spec?.egress ?? []).some((e) => (e.ports ?? []).some((p) => p.port !== 3128))) problems.push('the gates pod egress must be port 3128 only');
    const fetch = np('checks-fetch-egress');
    if (fetch?.spec?.podSelector?.matchLabels?.['tekton.dev/pipelineTask'] !== 'fetch') problems.push('only the clone step may reach the git server');
    const gitIn = np('allow-checks-fetch-to-git-http');
    if (gitIn?.spec?.ingress?.[0]?.from?.[0]?.podSelector?.matchLabels?.['tekton.dev/pipelineTask'] !== 'fetch') problems.push('the git server must admit only the clone step from the build namespace');
    const lis = np('checks-listener');
    if (lis?.spec?.ingress?.[0]?.from?.[0]?.podSelector?.matchLabels?.['app.kubernetes.io/component'] !== 'os-ui') problems.push('the listener must admit only os-ui');
    const listenerEgress = JSON.stringify(lis?.spec?.egress ?? []);
    if (!listenerEgress.includes('10.96.0.1/32')) problems.push('the listener egress must be narrowed to the API server address');
    if (!listenerEgress.includes('core-interceptors')) problems.push('the listener must reach the Triggers CEL interceptor (its validation is the listener\'s front door)');

    // the egress proxy allowlist names the npm registry only because tekton is on
    const proxy = docs.find((d) => d.kind === 'ConfigMap' && d.metadata?.name === 'egress-proxy-config');
    if (!/registry\\\.npmjs\\\.org/.test(proxy?.data?.filter ?? '')) problems.push('egress proxy allowlist lacks the npm registry');
  }
  try {
    const base = render(['--set', 'egressProxy.enabled=true'], [TEMPLATES[1]]);
    if (/registry\\\.npmjs\\\.org/.test(base)) problems.push('npm registry is on the egress allowlist while tekton is off');
  } catch (e) { problems.push(`default render of the proxy failed: ${String(e.stderr).slice(0, 200)}`); }
}

// ── App Builder build platform (workstream C1) ───────────────────────────────────────────────
// The build pod's Localhost seccomp profile (the approved fallback): RuntimeDefault's rules plus exactly the namespace
// and mount syscalls, never a permissive default; nested seccomp filters refused (EINVAL). Fresh render vs upstream:
// `node scripts/spo/render-seccomp-profile.mjs --check` (needs the network, so not here).
{
  const prof = JSON.parse(readFileSync(join(CHART, 'files/seccomp/buildkit-rootless.json'), 'utf8'));
  if (prof.defaultAction !== 'SCMP_ACT_ERRNO') problems.push('buildkit-rootless.json: defaultAction must be SCMP_ACT_ERRNO');
  const allowed = new Set(prof.syscalls.filter((r) => r.action === 'SCMP_ACT_ALLOW' && !r.args).flatMap((r) => r.names));
  for (const n of ['unshare', 'clone', 'mount', 'setns']) if (!allowed.has(n)) problems.push(`buildkit-rootless.json: ${n} not allowed (rootless BuildKit cannot start)`);
  for (const n of ['seccomp', 'prctl', 'bpf', 'init_module', 'kexec_load', 'reboot']) if (allowed.has(n)) problems.push(`buildkit-rootless.json: ${n} allowed unconditionally`);
}
// The env namespaces, registry and build steps (rendered; flag off renders none of it).
try {
  execFileSync(process.execPath, [join(repo, 'scripts/check-software-apps-envs-chart.mjs')], { stdio: 'inherit' });
} catch { problems.push('check-software-apps-envs-chart.mjs failed (above)'); }

if (problems.length) {
  console.error('check-software-tekton-chart: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('check-software-tekton-chart: ok - pins match the vendored tasks; the build namespace, RBAC, listener and network policies hold');
