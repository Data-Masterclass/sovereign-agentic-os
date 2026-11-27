#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    os-ui cannot read arbitrary platform Secrets, with external connectors on
 * USER STORY: As the owner I want CI to fail when the os-ui (or os-ui-worker) ServiceAccount can
 *             `get`, `list` or `watch` a platform Secret it has no business reading — Postgres,
 *             OpenSearch, LiteLLM, the session secret, the registry credentials — in any render,
 *             above all with `osUI.externalConnectorsEnabled` on (prod), which used to grant
 *             namespace-wide Secret reads in the release namespace.
 * ARCHITECTURE:
 *   - Renders the chart (values.local.yaml) in several value sets — flag off, flag on, flag on with
 *     the worker, the App Builder and the software runner on — and resolves, from the RENDERED
 *     manifests, every RoleBinding / ClusterRoleBinding whose subjects name the os-ui or
 *     os-ui-worker ServiceAccount, and the Role / ClusterRole each points at.
 *   - For each namespace where a binding applies (a ClusterRoleBinding applies everywhere), it asks
 *     exactly what Kubernetes RBAC would answer: may this ServiceAccount `get` Secret X, may it
 *     `list` / `watch` Secrets at all? A rule with `resourceNames` grants `get` on those names only;
 *     `list` / `watch` are treated as namespace-wide whatever `resourceNames` says.
 *   - The release namespace is the platform namespace: there os-ui may read no Secret except the
 *     named allowlist below (the read-only registry pull identity), and may never list or watch.
 *     The dedicated connection-secrets namespace is the one place a namespace-wide grant is by design.
 *   - Same skip rule as the other chart checks: a loud skip on a laptop without helm/subcharts, a
 *     FAILURE in CI.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'check-os-ui-secret-read-chart';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const VALUES = join(repo, 'values.local.yaml');
const REL = 'agentic-os';
const CONN_NS = `${REL}-conn-secrets`;
const SUBJECTS = new Set(['os-ui', 'os-ui-worker']);
/** The only Secrets os-ui may `get` in the release namespace, by name: the read-only registry pull identity. */
const RELEASE_NS_READ_ALLOW = new Set(['zot-pull']);
/** Platform Secrets named in the owner's brief: each must be unreadable in every render. */
const MUST_NOT_READ = [
  'postgres-app', 'postgres-superuser', 'opensearch-credentials', 'opensearch-admin', 'litellm-credentials',
  'litellm-master-key', 'os-ui-session', 'os-secrets-encryption-key', 'zot-auth', 'zot-keeper', 'zot-push',
  'trino-ext-anything', 'any-other-secret',
];

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
const sub = join(CHART, 'charts');
if (!(existsSync(sub) && readdirSync(sub).some((f) => f.endsWith('.tgz')))) skip('no subchart .tgz (helm dependency build)');
let yaml;
try {
  yaml = createRequire(join(repo, 'os-ui', 'package.json'))('js-yaml');
} catch {
  skip('js-yaml not installed (os-ui/node_modules)');
}

const render = (sets) =>
  yaml
    .loadAll(
      execFileSync('helm', ['template', 'soa', CHART, '-n', REL, '-f', VALUES, ...sets.flatMap((s) => ['--set', s])], {
        encoding: 'utf8',
        maxBuffer: 1 << 27,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
    .filter((d) => d && typeof d === 'object');

const CASES = [
  { label: 'externalConnectorsEnabled=false', sets: ['osUI.externalConnectorsEnabled=false'] },
  { label: 'externalConnectorsEnabled=true', sets: ['osUI.externalConnectorsEnabled=true'] },
  { label: 'externalConnectorsEnabled=true + worker', sets: ['osUI.externalConnectorsEnabled=true', 'osUI.worker.enabled=true'] },
  {
    label: 'externalConnectorsEnabled=true + worker + software runner + App Builder',
    sets: ['osUI.externalConnectorsEnabled=true', 'osUI.worker.enabled=true', 'softwareRunner.enabled=true', 'softwareRunner.environments.enabled=true'],
  },
];

const problems = [];
const lower = (xs) => (xs ?? []).map((x) => String(x).toLowerCase());
const touchesSecrets = (rule) => lower(rule.apiGroups).some((g) => g === '' || g === '*') && lower(rule.resources).some((r) => r === 'secrets' || r === '*');

for (const c of CASES) {
  let docs;
  try {
    docs = render(c.sets);
  } catch (e) {
    problems.push(`${c.label}: helm template failed — ${String(e.stderr ?? e.message).split('\n')[0]}`);
    continue;
  }
  const roles = new Map(); // `${kind}/${ns}/${name}` → rules
  for (const d of docs) {
    if (d.kind === 'Role') roles.set(`Role/${d.metadata?.namespace ?? REL}/${d.metadata?.name}`, d.rules ?? []);
    if (d.kind === 'ClusterRole') roles.set(`ClusterRole//${d.metadata?.name}`, d.rules ?? []);
  }
  // namespace ('*' = every namespace) → the rules bound to an os-ui ServiceAccount there
  const bound = new Map();
  const add = (ns, rules, via) => {
    if (!bound.has(ns)) bound.set(ns, []);
    for (const r of rules) bound.get(ns).push({ ...r, via });
  };
  for (const d of docs) {
    if (d.kind !== 'RoleBinding' && d.kind !== 'ClusterRoleBinding') continue;
    const ours = (d.subjects ?? []).some((s) => s.kind === 'ServiceAccount' && SUBJECTS.has(s.name) && (s.namespace ?? REL) === REL);
    if (!ours) continue;
    const ref = d.roleRef ?? {};
    const ns = d.kind === 'ClusterRoleBinding' ? '*' : d.metadata?.namespace ?? REL;
    const key = ref.kind === 'ClusterRole' ? `ClusterRole//${ref.name}` : `Role/${ns}/${ref.name}`;
    const rules = roles.get(key);
    if (!rules) continue; // a role this chart does not render (e.g. a platform ClusterRole) — nothing to read here
    add(ns, rules, `${d.kind} ${d.metadata?.name} → ${ref.kind} ${ref.name}`);
  }
  const rulesIn = (ns) => [...(bound.get(ns) ?? []), ...(bound.get('*') ?? [])].filter(touchesSecrets);
  const canGet = (ns, name) =>
    rulesIn(ns).some((r) => lower(r.verbs).some((v) => v === 'get' || v === '*') && (!r.resourceNames?.length || r.resourceNames.includes(name)));
  const canListOrWatch = (ns) => rulesIn(ns).some((r) => lower(r.verbs).some((v) => v === 'list' || v === 'watch' || v === '*'));

  // 1. The release (platform) namespace: no list / watch, no get beyond the named allowlist.
  if (canListOrWatch(REL)) {
    const via = rulesIn(REL).filter((r) => lower(r.verbs).some((v) => ['list', 'watch', '*'].includes(v))).map((r) => r.via);
    problems.push(`${c.label}: os-ui may list/watch Secrets in the release namespace (${[...new Set(via)].join('; ')})`);
  }
  for (const name of MUST_NOT_READ) {
    if (canGet(REL, name)) problems.push(`${c.label}: os-ui may get Secret ${name} in the release namespace`);
  }
  for (const r of rulesIn(REL)) {
    if (!lower(r.verbs).some((v) => v === 'get' || v === '*')) continue;
    const names = r.resourceNames ?? [];
    if (!names.length) problems.push(`${c.label}: a namespace-wide Secret get in the release namespace (${r.via})`);
    for (const n of names) if (!RELEASE_NS_READ_ALLOW.has(n)) problems.push(`${c.label}: os-ui may get Secret ${n} in the release namespace (${r.via}) — not in the allowlist`);
  }
  // 2. No cluster-wide Secret right at all.
  if ((bound.get('*') ?? []).some(touchesSecrets)) problems.push(`${c.label}: a ClusterRoleBinding gives os-ui a cluster-wide Secret right`);
  // 3. The external-connector feature still works: create + update (no get/list) of its own Secrets.
  if (c.sets.includes('osUI.externalConnectorsEnabled=true')) {
    const own = (bound.get(REL) ?? []).filter(touchesSecrets).filter((r) => (r.via ?? '').includes('Role os-ui') && !r.resourceNames?.length);
    const verbs = new Set(own.flatMap((r) => lower(r.verbs)));
    for (const need of ['create', 'update']) if (!verbs.has(need)) problems.push(`${c.label}: the os-ui Role lost Secret \`${need}\` — live warehouse catalog registration writes trino-ext-<catalog>`);
  }
  // 4. The dedicated connection-secrets namespace keeps its by-design grant (sanity: we did not move it here).
  if (!canListOrWatch(CONN_NS)) problems.push(`${c.label}: the connection-secrets namespace grant is gone — re-read check-connection-secrets-chart.mjs`);
}

if (problems.length) {
  console.error(`${NAME} FAILED:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `${NAME}: ok — in ${CASES.length} value sets os-ui can neither list/watch nor get Secrets in the release namespace ` +
    `(except ${[...RELEASE_NS_READ_ALLOW].join(', ')} by name), has no cluster-wide Secret right, and keeps create/update for trino-ext-<catalog>`,
);
