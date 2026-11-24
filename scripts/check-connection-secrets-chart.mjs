#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    The chart wires the durable, encrypted connection-credential store with least privilege
 * USER STORY: As a security reviewer I want CI to fail when the store loses its RBAC or its encryption
 *             key, or when os-ui / the agent-run worker gain Secret rights in the platform namespace —
 *             because the first two lose (or expose) every connection credential and the third hands a
 *             compromised pod the LiteLLM master key and the session-signing secret.
 * ARCHITECTURE:
 *   - Renders the chart (values.local.yaml, worker on) and asserts on the RENDERED manifests:
 *     (0) LEAST PRIVILEGE (PR #334 review B1): the credentials live in a DEDICATED namespace; no
 *         RoleBinding in the RELEASE namespace binds os-ui or os-ui-worker to a Role that grants
 *         `secrets` (the externalConnectorsEnabled rule is off in this render); the worker runs as its
 *         own `os-ui-worker` ServiceAccount with a read-only Role and no other binding but the
 *         connection-secrets one; setting the dedicated namespace to the release namespace fails;
 *     (1) Role `os-ui-connection-secrets` (dedicated namespace) grants on `secrets` EXACTLY
 *         get/list/create/update/delete (no patch, watch or `*`), bound to os-ui AND os-ui-worker;
 *     (2) both pods set OS_SECRETS_BACKEND=kubernetes, OS_SECRETS_NAMESPACE=<dedicated namespace>, and
 *         read OS_SECRETS_ENCRYPTION_KEY from `os-secrets-encryption-key` (never optional);
 *     (3) that Secret is in the release namespace, lookup-preserved, `helm.sh/resource-policy: keep`
 *         and excluded from Velero; an explicit value renders unchanged; `existingSecret` renders no
 *         Secret and both pods point at it; a short key fails; `gitops: true` without a key fails.
 *   - Same skip rule as check-worker-env.mjs: a loud skip on a laptop without helm/subcharts, a FAILURE in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const VALUES = join(repo, 'values.local.yaml');
const TEMPLATE = join(CHART, 'templates', 'base', 'os-ui', 'os-ui-connection-secrets.yaml');
const KEY_SECRET = 'os-secrets-encryption-key';
const NAME = 'check-connection-secrets';
const REL = 'agentic-os';
const CONN_NS = `${REL}-conn-secrets`;

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

const render = (...extra) =>
  execFileSync('helm', ['template', 'soa', CHART, '-n', REL, '-f', VALUES, '--set', 'osUI.worker.enabled=true', ...extra], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const renderFails = (...extra) => {
  try {
    render(...extra);
    return false;
  } catch {
    return true;
  }
};
const docs = (text) => text.split(/^---$/m);
const kindIs = (d, kind) => new RegExp(`^kind: ${kind}$`, 'm').test(d);
const nameOf = (d) => d.match(/^metadata:\n(?:.*\n)*?\s{2}name: "?([^"\n]+)"?$/m)?.[1];
const nsOf = (d) => d.match(/^\s{2}namespace: "?([^"\n]+)"?$/m)?.[1];
const named = (text, kind, name, ns) => docs(text).find((d) => kindIs(d, kind) && nameOf(d) === name && (!ns || nsOf(d) === ns));
const grantsSecrets = (role) => [...role.matchAll(/^\s*resources: \[(.*)\]\s*$/gm)].some((m) => /"secrets"/.test(m[1]));
/** Does a Role let its subject READ or MODIFY existing Secrets (get/list/watch/update/patch/*)? The
 *  software scanner's write-only create+delete of its own payload Secret is not a read path. */
const readsSecrets = (role) =>
  role.split(/\n\s+- apiGroups:/).slice(1).some((r) => /resources: \[[^\]]*"secrets"/.test(r) && /verbs: \[[^\]]*"(get|list|watch|update|patch|\*)"/.test(r));
const keySource = (doc) => doc?.match(/- name: OS_SECRETS_ENCRYPTION_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: "?([^"\n]+)"?\n\s+key: OS_SECRETS_ENCRYPTION_KEY(\n\s+optional: true)?/);
const subjectsOf = (b) => [...b.matchAll(/kind: ServiceAccount,?\s*\n?\s*name: "?([a-z0-9-]+)"?/g), ...b.matchAll(/kind: ServiceAccount, name: ([a-z0-9-]+)/g)].map((m) => m[1]);
const roleRefOf = (b) => b.match(/roleRef:[\s\S]*?name: "?([a-z0-9-]+)"?/)?.[1];

const problems = [];
const out = render();

// (0) least privilege
if (!docs(out).some((d) => kindIs(d, 'Namespace') && nameOf(d) === CONN_NS)) problems.push(`the dedicated namespace ${CONN_NS} is not rendered`);
const relRoles = new Map(docs(out).filter((d) => kindIs(d, 'Role') && nsOf(d) === REL).map((d) => [nameOf(d), d]));
for (const b of docs(out).filter((d) => kindIs(d, 'RoleBinding') && nsOf(d) === REL)) {
  const role = relRoles.get(roleRefOf(b));
  const who = subjectsOf(b).filter((s) => s === 'os-ui' || s === 'os-ui-worker');
  if (role && readsSecrets(role) && who.length) problems.push(`RoleBinding ${nameOf(b)} lets ${who.join(', ')} READ Secrets in the RELEASE namespace (Role ${roleRefOf(b)}) — connection secrets belong in ${CONN_NS}`);
}
const workerDep = named(out, 'Deployment', 'os-ui-worker');
if (!/serviceAccountName: os-ui-worker\n/.test(workerDep ?? '')) problems.push('os-ui-worker must run as its own ServiceAccount os-ui-worker');
if (!named(out, 'ServiceAccount', 'os-ui-worker', REL)) problems.push('ServiceAccount os-ui-worker not rendered');
const workerRole = relRoles.get('os-ui-worker');
if (!workerRole) problems.push('Role os-ui-worker not rendered');
else {
  if (grantsSecrets(workerRole) || /configmaps|cronjobs|"\*"/.test(workerRole)) problems.push('Role os-ui-worker must not grant secrets, configmaps, cronjobs or *');
  if (/verbs: \[[^\]]*"(create|update|patch|delete|watch)"/.test(workerRole)) problems.push('Role os-ui-worker must be read-only (get/list)');
}
for (const b of docs(out).filter((d) => (kindIs(d, 'RoleBinding') || kindIs(d, 'ClusterRoleBinding')) && subjectsOf(d).includes('os-ui-worker'))) {
  if (!['os-ui-worker', 'os-ui-connection-secrets'].includes(nameOf(b))) problems.push(`os-ui-worker is bound by ${nameOf(b)} — the worker gets only its own Role and the connection-secrets Role`);
}
if (!renderFails('--set', `osUI.connectionSecrets.namespace=${REL}`)) problems.push('setting the connection-secrets namespace to the release namespace must fail the render');

// (1) the connection-secrets RBAC
const role = named(out, 'Role', 'os-ui-connection-secrets');
if (!role) problems.push('Role os-ui-connection-secrets not rendered');
else {
  if (nsOf(role) !== CONN_NS) problems.push(`Role os-ui-connection-secrets is in ${nsOf(role)}, must be in ${CONN_NS}`);
  const rules = role.split(/\n\s+- apiGroups:/).slice(1);
  if (rules.length !== 1) problems.push(`os-ui-connection-secrets must have exactly one rule, has ${rules.length}`);
  const verbs = (role.match(/verbs: \[(.*)\]/)?.[1] ?? '').split(',').map((v) => v.trim().replace(/"/g, '')).sort();
  const want = ['create', 'delete', 'get', 'list', 'update'];
  if (JSON.stringify(verbs) !== JSON.stringify(want)) problems.push(`secrets verbs are [${verbs}] — must be exactly [${want}] (no patch/watch/*)`);
  if (!/resources: \["secrets"\]/.test(role)) problems.push('the rule must name only "secrets"');
}
const binding = named(out, 'RoleBinding', 'os-ui-connection-secrets');
const bound = binding ? subjectsOf(binding) : [];
if (!binding || nsOf(binding) !== CONN_NS || !bound.includes('os-ui') || !bound.includes('os-ui-worker') || !new RegExp(`namespace: ${REL}\\n`).test(binding)) {
  problems.push(`RoleBinding os-ui-connection-secrets (in ${CONN_NS}) must bind the os-ui and os-ui-worker ServiceAccounts of ${REL}`);
}

// (2) both pods
for (const pod of ['os-ui', 'os-ui-worker']) {
  const d = named(out, 'Deployment', pod);
  if (!d) { problems.push(`${pod} Deployment not rendered`); continue; }
  if (!/- name: OS_SECRETS_BACKEND\n\s+value: "kubernetes"/.test(d)) problems.push(`${pod}: OS_SECRETS_BACKEND must be "kubernetes" (explicit — the app never falls back to memory in a cluster)`);
  if (!new RegExp(`- name: OS_SECRETS_NAMESPACE\\n\\s+value: "${CONN_NS}"`).test(d)) problems.push(`${pod}: OS_SECRETS_NAMESPACE must be "${CONN_NS}"`);
  const m = keySource(d);
  if (!m) problems.push(`${pod}: OS_SECRETS_ENCRYPTION_KEY must come from a secretKeyRef`);
  else {
    if (m[1] !== KEY_SECRET) problems.push(`${pod}: OS_SECRETS_ENCRYPTION_KEY reads ${m[1]}, expected ${KEY_SECRET}`);
    if (m[2]) problems.push(`${pod}: OS_SECRETS_ENCRYPTION_KEY must not be optional`);
  }
}

// (3) the key Secret
const tpl = readFileSync(TEMPLATE, 'utf8');
if (!/lookup "v1" "Secret" \.Release\.Namespace \$keyName/.test(tpl)) problems.push('the key Secret must be read back with lookup (kept across upgrades)');
const sec = named(out, 'Secret', KEY_SECRET);
if (!sec) problems.push(`${KEY_SECRET} not rendered`);
else {
  if (!/"helm\.sh\/resource-policy": keep/.test(sec)) problems.push(`${KEY_SECRET} must carry helm.sh/resource-policy: keep`);
  if (!/velero\.io\/exclude-from-backup: "true"/.test(sec)) problems.push(`${KEY_SECRET} must be excluded from Velero backups (never in one backup with the ciphertext)`);
  if (nsOf(sec) !== REL) problems.push(`${KEY_SECRET} must be in the release namespace (a pod reads secretKeyRefs from its own namespace)`);
}
const explicit = 'e'.repeat(48);
const v1 = named(render('--set', `osUI.connectionSecrets.secret=${explicit}`), 'Secret', KEY_SECRET);
const v2 = named(render('--set', `osUI.connectionSecrets.secret=${explicit}`), 'Secret', KEY_SECRET);
if (!v1?.includes(`OS_SECRETS_ENCRYPTION_KEY: "${explicit}"`) || v1 !== v2) problems.push('an explicit connectionSecrets.secret must render unchanged');
const ext = render('--set', 'osUI.connectionSecrets.existingSecret=my-key');
if (named(ext, 'Secret', KEY_SECRET)) problems.push('existingSecret set: the chart must not render its own key Secret');
for (const pod of ['os-ui', 'os-ui-worker']) if (keySource(named(ext, 'Deployment', pod))?.[1] !== 'my-key') problems.push(`existingSecret set: ${pod} must read my-key`);
if (!renderFails('--set', 'osUI.connectionSecrets.secret=short')) problems.push('a key shorter than 32 characters must fail the render');
if (!renderFails('--set', 'osUI.connectionSecrets.gitops=true')) problems.push('gitops: true without a key must fail the render');
if (renderFails('--set', 'osUI.connectionSecrets.gitops=true', '--set', 'osUI.connectionSecrets.existingSecret=my-key')) problems.push('gitops: true WITH existingSecret must render');

if (problems.length) {
  console.error(`${NAME}: FAILED\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`${NAME}: ok — credentials in ${CONN_NS} only (no Secret grant to os-ui/os-ui-worker in the release namespace); worker on its own read-only ServiceAccount; exact Role verbs; both pods use the kubernetes backend, the dedicated namespace and the kept, backup-excluded key; explicit/existing/short/gitops key paths behave`);
