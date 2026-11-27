#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test - App Builder app databases (workstream D): CloudNativePG `apps-pg` per env, its
 *             NetworkPolicies, os-ui's Role and the admission policies narrowing it, the os-ui env.
 * USER STORY: As the owner I want the chart to prove that app databases render only when I switch them on, that no
 *             superuser credential exists, that pg_hba isolates apps, that only app pods and migrate Jobs reach
 *             Postgres, and that os-ui's rights there are exactly the ones the plan names.
 * ARCHITECTURE: renders the chart with helm (spec 15 "Chart checks"):
 *   - flag OFF (default) and flag ON with mode "": no Cluster, NetworkPolicy, Role or policy of D renders; flag off ⇒ the
 *     os-ui env carries no SOFTWARE_APP_DATABASES_* key;
 *   - flag ON + mode cnpg + image + CNPG API: every property below; mode external: env only, no object;
 *   - negative twins: no image, a tag instead of a digest, no CNPG CRDs, no API server address, a bogus mode ⇒ the
 *     render FAILS.
 *   Skips loudly without helm or subchart tarballs; in CI (`process.env.CI`) a skip is a FAILURE. Run by
 *   os-ui/scripts/gate.sh.
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
const T = {
  db: 'templates/base/os-ui/software-app-databases.yaml',
  rbac: 'templates/base/os-ui/software-app-databases-rbac.yaml',
  osui: 'templates/base/os-ui/os-ui.yaml',
};
const IMAGE = `ghcr.io/cloudnative-pg/postgresql@sha256:${'b'.repeat(64)}`;
const BASE = ['--set', 'osUI.enabled=true', '--set', 'networkPolicies.apiserver.cidrs={10.96.0.1/32}', '--set', 'networkPolicies.apiserver.extraCidrs={188.34.71.35/32}'];
const ONF = [...BASE, '--set', 'softwareRunner.environments.enabled=true'];
const CNPG = [...ONF, '--set', 'osUI.software.databases.mode=cnpg', '--set', `osUI.software.databases.imageName=${IMAGE}`, '--api-versions', 'postgresql.cnpg.io/v1/Cluster'];

function render(extra, only) {
  return execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation', ...extra, ...only.flatMap((t) => ['--show-only', t])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryRender(extra, only) {
  try { return { out: render(extra, only), err: '' }; } catch (e) { return { out: '', err: String(e.stderr || e.message) }; }
}
const empty = (r) => !r.out.replace(/#[^\n]*|---|\s/g, '') && (!r.err || /could not find template/.test(r.err));
const helmOk = (() => { try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const depsOk = existsSync(join(CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
if (!helmOk || !depsOk) {
  const msg = `check-software-app-databases-chart: ${helmOk ? 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)' : 'helm not on PATH'} - SKIPPED`;
  if (process.env.CI) { console.error(msg); process.exit(1); }
  console.warn(msg); process.exit(0);
}
const envOf = (out) => {
  const dep = yaml.loadAll(out).filter(Boolean).find((d) => d.kind === 'Deployment' && d.metadata?.name === 'os-ui');
  const c = (dep?.spec?.template?.spec?.containers ?? []).find((x) => x.name === 'os-ui') ?? dep?.spec?.template?.spec?.containers?.[0];
  return Object.fromEntries((c?.env ?? []).map((e) => [e.name, e.value]));
};

// ── off, and on without mode: nothing ────────────────────────────────────────────────────────
for (const [label, flags] of [['flag off', BASE], ['flag on, mode ""', ONF], ['flag off even with mode cnpg', [...BASE, '--set', 'osUI.software.databases.mode=cnpg', '--set', `osUI.software.databases.imageName=${IMAGE}`]]]) {
  for (const t of [T.db, T.rbac]) if (!empty(tryRender(flags, [t]))) problems.push(`${label}: ${t} renders something`);
}
if (Object.keys(envOf(render(BASE, [T.osui]))).some((k) => k.startsWith('SOFTWARE_APP_DATABASES'))) problems.push('flag off: the os-ui env carries SOFTWARE_APP_DATABASES_*');
{
  const env = envOf(render(ONF, [T.osui]));
  if (env.SOFTWARE_APP_DATABASES_MODE !== '' || env.SOFTWARE_APP_DATABASES_CLUSTER !== 'apps-pg') problems.push(`flag on, mode "": env MODE/CLUSTER = ${JSON.stringify([env.SOFTWARE_APP_DATABASES_MODE, env.SOFTWARE_APP_DATABASES_CLUSTER])}`);
}

// ── negative twins: the render refuses ───────────────────────────────────────────────────────
const refuse = (label, flags, only, re) => {
  const r = tryRender(flags, only);
  if (!r.err || !re.test(r.err)) problems.push(`${label}: expected the render to fail matching ${re}, got ${r.err ? r.err.slice(0, 200) : 'success'}`);
};
refuse('no operand image', [...ONF, '--set', 'osUI.software.databases.mode=cnpg', '--api-versions', 'postgresql.cnpg.io/v1/Cluster'], [T.db], /imageName must be <repository>@sha256/);
refuse('a tag instead of a digest', [...ONF, '--set', 'osUI.software.databases.mode=cnpg', '--set', 'osUI.software.databases.imageName=ghcr.io/cloudnative-pg/postgresql:18', '--api-versions', 'postgresql.cnpg.io/v1/Cluster'], [T.db], /imageName must be/);
refuse('no CNPG CRDs', [...ONF, '--set', 'osUI.software.databases.mode=cnpg', '--set', `osUI.software.databases.imageName=${IMAGE}`], [T.db], /CloudNativePG CRDs are not installed/);
refuse('no API server address', ['--set', 'osUI.enabled=true', '--set', 'softwareRunner.environments.enabled=true', '--set', 'osUI.software.databases.mode=cnpg', '--set', `osUI.software.databases.imageName=${IMAGE}`, '--api-versions', 'postgresql.cnpg.io/v1/Cluster'], [T.db], /networkPolicies.apiserver.cidrs is required for the app databases/);
refuse('a bogus mode', [...ONF, '--set', 'osUI.software.databases.mode=sqlite'], [T.osui], /mode must be cnpg, external or empty/);

// ── external: env only ───────────────────────────────────────────────────────────────────────
{
  const ext = [...ONF, '--set', 'osUI.software.databases.mode=external'];
  for (const t of [T.db, T.rbac]) if (!empty(tryRender(ext, [t]))) problems.push(`mode external: ${t} renders an object (external is designed, not built)`);
  if (envOf(render(ext, [T.osui])).SOFTWARE_APP_DATABASES_MODE !== 'external') problems.push('mode external: os-ui env does not say external');
}

// ── cnpg: every property ─────────────────────────────────────────────────────────────────────
let docs = [];
try { docs = yaml.loadAll(render(CNPG, [T.db, T.rbac])).filter(Boolean); } catch (e) { problems.push(`mode cnpg: render failed: ${String(e.stderr || e.message).slice(0, 400)}`); }
const of = (kind, ns) => docs.filter((d) => d.kind === kind && (!ns || d.metadata?.namespace === ns));
for (const ns of ['apps-dev', 'apps-prod']) {
  const cl = of('Cluster', ns);
  if (cl.length !== 1 || cl[0].metadata.name !== 'apps-pg') { problems.push(`${ns}: expected exactly one Cluster apps-pg, got ${cl.map((c) => c.metadata.name)}`); continue; }
  const s = cl[0].spec;
  if (s.enableSuperuserAccess !== false) problems.push(`${ns}: enableSuperuserAccess must be false`);
  if (s.instances !== 1) problems.push(`${ns}: instances default must be 1, got ${s.instances}`);
  if (s.imageName !== IMAGE) problems.push(`${ns}: imageName not the configured digest`);
  if (JSON.stringify(s.postgresql?.pg_hba) !== JSON.stringify(['hostssl sameuser all all scram-sha-256', 'host all all all reject'])) problems.push(`${ns}: pg_hba must be exactly sameuser + reject, got ${JSON.stringify(s.postgresql?.pg_hba)}`);
  if (s.priorityClassName !== 'soa-app-databases') problems.push(`${ns}: the instances must use the non-preempting soa-app-databases PriorityClass by default`);
  if (JSON.stringify(s).includes('superuserSecret')) problems.push(`${ns}: a superuser Secret is referenced`);
  const np = Object.fromEntries(of('NetworkPolicy', ns).map((p) => [p.metadata.name, p.spec]));
  for (const n of ['apps-pg-ingress', 'apps-pg-egress', 'apps-to-apps-pg', 'app-migrate-egress']) if (!np[n]) problems.push(`${ns}: NetworkPolicy ${n} missing`);
  const ing = np['apps-pg-ingress'];
  if (ing) {
    if (ing.podSelector?.matchLabels?.['cnpg.io/cluster'] !== 'apps-pg') problems.push(`${ns}: apps-pg-ingress does not select the Cluster's pods`);
    if (ing.ingress.some((r) => !r.from?.length)) problems.push(`${ns}: apps-pg-ingress has a rule without a source (open to all)`);
    if (ing.ingress.some((r) => r.from.some((f) => f.namespaceSelector && !f.podSelector))) problems.push(`${ns}: apps-pg-ingress admits a whole namespace`);
    const appRule = ing.ingress.find((r) => r.from.some((f) => f.podSelector?.matchLabels?.['soa.dev/role'] === 'app-migrate'));
    if (!appRule || JSON.stringify(appRule.ports) !== JSON.stringify([{ protocol: 'TCP', port: 5432 }]) || appRule.from.some((f) => f.namespaceSelector)) problems.push(`${ns}: app pods / migrate Jobs must get 5432 only, from this namespace only`);
    const op = ing.ingress.find((r) => r.from.some((f) => f.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'cnpg-system'));
    if (!op || JSON.stringify(op.ports) !== JSON.stringify([{ protocol: 'TCP', port: 8000 }])) problems.push(`${ns}: the operator must reach 8000 only`);
  }
  const eg = np['apps-pg-egress'];
  if (eg) {
    const api = eg.egress.find((r) => r.to.some((t) => t.ipBlock));
    const cidrs = (api?.to ?? []).map((t) => t.ipBlock?.cidr);
    if (JSON.stringify(cidrs) !== JSON.stringify(['10.96.0.1/32', '188.34.71.35/32'])) problems.push(`${ns}: apps-pg egress to the API server must be exactly the configured CIDRs, got ${JSON.stringify(cidrs)}`);
    if (eg.egress.some((r) => !r.to?.length)) problems.push(`${ns}: apps-pg egress has a rule to anywhere`);
  }
  for (const n of ['apps-to-apps-pg', 'app-migrate-egress']) {
    const p = np[n];
    if (p && (p.egress.length !== 1 || p.egress[0].to[0].podSelector?.matchLabels?.['cnpg.io/cluster'] !== 'apps-pg' || JSON.stringify(p.egress[0].ports) !== JSON.stringify([{ protocol: 'TCP', port: 5432 }]))) problems.push(`${ns}: ${n} must allow apps-pg:5432 and nothing else`);
  }
  const role = of('Role', ns).find((r) => r.metadata.name === 'os-ui-app-databases');
  if (!role) { problems.push(`${ns}: Role os-ui-app-databases missing`); continue; }
  const rule = (g, r) => role.rules.find((x) => x.apiGroups.includes(g) && x.resources.includes(r));
  const cr = rule('postgresql.cnpg.io', 'clusters');
  if (!cr || JSON.stringify(cr.resourceNames) !== JSON.stringify(['apps-pg']) || JSON.stringify(cr.verbs) !== JSON.stringify(['get', 'patch'])) problems.push(`${ns}: clusters must be get/patch on apps-pg only`);
  if (JSON.stringify(rule('postgresql.cnpg.io', 'databases')?.verbs) !== JSON.stringify(['create', 'get', 'list', 'delete'])) problems.push(`${ns}: databases verbs`);
  if (JSON.stringify(rule('', 'secrets')?.verbs) !== JSON.stringify(['create', 'patch', 'delete'])) problems.push(`${ns}: os-ui may write Secrets here but never read them (no get/list/watch)`);
  if (role.rules.some((x) => x.resources.includes('secrets') && x.verbs.some((v) => ['get', 'list', 'watch'].includes(v)))) problems.push(`${ns}: a rule lets os-ui read Secrets`);
  if (JSON.stringify(rule('', 'configmaps')?.verbs) !== JSON.stringify(['create', 'get', 'patch'])) problems.push(`${ns}: configmaps verbs (the env list)`);
  if (JSON.stringify(rule('batch', 'jobs')?.verbs) !== JSON.stringify(['create', 'get', 'list', 'delete'])) problems.push(`${ns}: jobs verbs`);
  if (role.rules.some((x) => x.verbs.includes('*') || x.resources.includes('*') || x.apiGroups.includes('*'))) problems.push(`${ns}: a wildcard in os-ui's Role`);
  const rb = of('RoleBinding', ns).find((r) => r.metadata.name === 'os-ui-app-databases');
  if (!rb || !rb.subjects.some((s) => s.name === 'os-ui' && s.namespace === 'agentic-os')) problems.push(`${ns}: RoleBinding to os-ui missing`);
}
{
  const pc = of('PriorityClass').find((p) => p.metadata.name === 'soa-app-databases');
  if (!pc || pc.preemptionPolicy !== 'Never' || pc.globalDefault !== false) problems.push('PriorityClass soa-app-databases must render with preemptionPolicy Never, not global default');
}
const vap = Object.fromEntries(of('ValidatingAdmissionPolicy').map((p) => [p.metadata.name, p.spec]));
const vapb = Object.fromEntries(of('ValidatingAdmissionPolicyBinding').map((p) => [p.metadata.name, p.spec]));
const POLICIES = {
  'app-databases-os-ui-clusters': [['postgresql.cnpg.io', 'clusters']],
  'app-databases-os-ui-databases': [['postgresql.cnpg.io', 'databases']],
  'app-databases-os-ui-secrets': [['', 'secrets']],
  'app-databases-os-ui-configmaps': [['', 'configmaps']],
  'app-databases-os-ui-jobs': [['batch', 'jobs']],
  'app-databases-os-ui-workloads': [['apps', 'deployments'], ['apps', 'replicasets'], ['apps', 'statefulsets'], ['apps', 'daemonsets']],
  'app-databases-os-ui-cronjobs': [['batch', 'cronjobs']],
  'app-databases-os-ui-pods': [['', 'pods']],
};
const exprs = (n) => (vap[n]?.validations ?? []).map((v) => v.expression).join('\n');
for (const [n, rr] of Object.entries(POLICIES)) {
  const rules = vap[n]?.matchConstraints?.resourceRules ?? [];
  for (const [g, r] of rr) if (!rules.some((x) => x.apiGroups.includes(g) && x.resources.includes(r))) problems.push(`${n}: does not match ${g || 'core'}/${r}`);
}
// The Cluster policy compares EVERY .spec property except managed (generated from files/cnpg/cluster-spec-fields.txt).
{
  const { readFileSync } = await import('node:fs');
  const fields = readFileSync(join(CHART, 'files/cnpg/cluster-spec-fields.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const e = exprs('app-databases-os-ui-clusters');
  for (const f of fields) {
    const compared = e.includes(`object.spec.${f} == oldObject.spec.${f}`);
    if (f === 'managed' ? compared : !compared) problems.push(`clusters policy: .spec.${f} ${f === 'managed' ? 'must stay changeable (roles)' : 'is not compared with the old object'}`);
  }
  for (const flag of ['superuser', 'createdb', 'createrole', 'replication', 'bypassrls', 'inRoles', "r.ensure == 'present'", 'passwordSecret.name.endsWith', 'object.metadata.annotations == oldObject.metadata.annotations', 'managed.services == oldObject']) {
    if (!e.includes(flag)) problems.push(`clusters policy: no rule on ${flag}`);
  }
  const d = exprs('app-databases-os-ui-databases');
  for (const f of ['extensions', 'schemas', 'fdws', 'servers', 'template']) if (!d.includes(`!has(object.spec.${f})`)) problems.push(`databases policy: ${f} not forbidden`);
  for (const r of ['object.spec.owner == object.spec.name', "databaseReclaimPolicy == 'retain'", "object.spec.ensure == 'present'"]) if (!d.includes(r)) problems.push(`databases policy: missing ${r}`);
  const sec = exprs('app-databases-os-ui-secrets');
  if (!sec.includes("-[0-9a-f]{8}-(db|env)$") || !sec.includes("!variables.name.endsWith('-db')")) problems.push('secrets policy: name pattern or the no-update rule on -db Secrets is missing');
  if (!e.includes('object.metadata.ownerReferences == oldObject.metadata.ownerReferences')) problems.push('clusters policy: ownerReferences not compared');
  if (!sec.includes("object.metadata.annotations['soa.dev/domain'] == oldObject.metadata.annotations['soa.dev/domain']")) problems.push('secrets policy: owner annotations not immutable');
  const j = exprs('app-databases-os-ui-jobs');
  for (const r of ["c.command == ['node', '/app/migrate/isolate.mjs']", 'readOnlyRootFilesystem == true', '!has(c.args)']) if (!j.includes(r)) problems.push(`jobs policy: missing ${r}`);
  if (!j.includes('false')) problems.push('jobs policy: with no app registry configured every Job must be refused');
  for (const n of ['app-databases-os-ui-workloads', 'app-databases-os-ui-cronjobs', 'app-databases-os-ui-pods', 'app-databases-os-ui-jobs']) {
    if (!exprs(n).includes("e.value.contains('-----BEGIN')")) problems.push(`${n}: literal PEM env values not refused`);
    const w = exprs(n);
    for (const r of ['secretKeyRef.name in variables.own', 'secretRef.name in variables.own', 'v.secret.secretName in variables.own', '!has(s.serviceAccountToken)', 'automountServiceAccountToken == false', "!k.startsWith('cnpg.io/')"]) {
      if (!w.includes(r)) problems.push(`${n}: missing ${r}`);
    }
  }
}
for (const n of Object.keys(POLICIES)) {
  if (!vap[n]) { problems.push(`policy ${n} missing`); continue; }
  if (vap[n].failurePolicy !== 'Fail') problems.push(`${n}: failurePolicy must be Fail`);
  if (JSON.stringify(vap[n].matchConstraints.namespaceSelector.matchExpressions[0].values) !== JSON.stringify(['apps-dev', 'apps-prod'])) problems.push(`${n}: must match exactly apps-dev and apps-prod`);
  if (!vap[n].matchConditions[0].expression.includes('system:serviceaccount:agentic-os:os-ui')) problems.push(`${n}: must match os-ui's identity`);
  if (!vapb[n] || vapb[n].policyName !== n || JSON.stringify(vapb[n].validationActions) !== JSON.stringify(['Deny'])) problems.push(`${n}: binding missing or not Deny`);
}
{
  const env = envOf(render(CNPG, [T.osui]));
  if (env.SOFTWARE_APP_DATABASES_MODE !== 'cnpg' || env.SOFTWARE_APP_DATABASES_CLUSTER !== 'apps-pg') problems.push('mode cnpg: os-ui env MODE/CLUSTER');
}

if (problems.length) {
  console.error(`check-software-app-databases-chart: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('check-software-app-databases-chart: ok (off/on/external/cnpg renders, negative twins refused)');
