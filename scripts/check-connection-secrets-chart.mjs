#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    The chart wires the durable, encrypted connection-credential store
 * USER STORY: As a security reviewer I want CI to fail when the store loses its RBAC, its encryption key,
 *             or gains more Secret rights than it needs — because without the first two every connection
 *             credential is lost (or stored unencrypted) and the third widens what a compromised pod reads.
 * ARCHITECTURE:
 *   - Renders the chart (values.local.yaml, worker on) and asserts on the RENDERED manifests:
 *     (1) Role `os-ui-connection-secrets` grants on `secrets` EXACTLY get/list/create/update/delete
 *         (no patch, watch or `*`) and nothing else, bound to the `os-ui` ServiceAccount (os-ui + worker);
 *     (2) both pods set OS_SECRETS_BACKEND=kubernetes and read OS_SECRETS_ENCRYPTION_KEY from
 *         `os-secrets-encryption-key` (never optional);
 *     (3) that Secret is lookup-preserved and `helm.sh/resource-policy: keep`; an explicit value renders
 *         unchanged; `existingSecret` renders no Secret and both pods point at it; a short key fails.
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
  execFileSync('helm', ['template', 'soa', CHART, '-n', 'agentic-os', '-f', VALUES, '--set', 'osUI.worker.enabled=true', ...extra], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const docs = (text) => text.split(/^---$/m);
const named = (text, kind, name) => docs(text).find((d) => new RegExp(`^kind: ${kind}$`, 'm').test(d) && new RegExp(`^\\s{2}name: "?${name}"?$`, 'm').test(d));
const keySource = (doc) => doc?.match(/- name: OS_SECRETS_ENCRYPTION_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: "?([^"\n]+)"?\n\s+key: OS_SECRETS_ENCRYPTION_KEY(\n\s+optional: true)?/);

const problems = [];
const out = render();

// (1) RBAC
const role = named(out, 'Role', 'os-ui-connection-secrets');
if (!role) problems.push('Role os-ui-connection-secrets not rendered');
else {
  const rules = role.split(/\n\s+- apiGroups:/).slice(1);
  if (rules.length !== 1) problems.push(`os-ui-connection-secrets must have exactly one rule, has ${rules.length}`);
  const verbs = (role.match(/verbs: \[(.*)\]/)?.[1] ?? '').split(',').map((v) => v.trim().replace(/"/g, '')).sort();
  const want = ['create', 'delete', 'get', 'list', 'update'];
  if (JSON.stringify(verbs) !== JSON.stringify(want)) problems.push(`secrets verbs are [${verbs}] — must be exactly [${want}] (no patch/watch/*)`);
  if (!/resources: \["secrets"\]/.test(role)) problems.push('the rule must name only "secrets"');
}
const binding = named(out, 'RoleBinding', 'os-ui-connection-secrets');
if (!binding || !/name: os-ui-connection-secrets/.test(binding) || !/kind: ServiceAccount\n\s+name: os-ui\n/.test(binding)) problems.push('RoleBinding os-ui-connection-secrets must bind the Role to ServiceAccount os-ui');

// (2) both pods
for (const pod of ['os-ui', 'os-ui-worker']) {
  const d = named(out, 'Deployment', pod);
  if (!d) { problems.push(`${pod} Deployment not rendered`); continue; }
  if (!/- name: OS_SECRETS_BACKEND\n\s+value: "kubernetes"/.test(d)) problems.push(`${pod}: OS_SECRETS_BACKEND must be "kubernetes" (explicit — the app never falls back to memory in a cluster)`);
  const m = keySource(d);
  if (!m) problems.push(`${pod}: OS_SECRETS_ENCRYPTION_KEY must come from a secretKeyRef`);
  else {
    if (m[1] !== KEY_SECRET) problems.push(`${pod}: OS_SECRETS_ENCRYPTION_KEY reads ${m[1]}, expected ${KEY_SECRET}`);
    if (m[2]) problems.push(`${pod}: OS_SECRETS_ENCRYPTION_KEY must not be optional`);
  }
  if (!/serviceAccountName: os-ui\n/.test(d)) problems.push(`${pod}: must run as ServiceAccount os-ui (the Role is bound to it)`);
}

// (3) the key Secret
const tpl = readFileSync(TEMPLATE, 'utf8');
if (!/lookup "v1" "Secret" \.Release\.Namespace \$name/.test(tpl)) problems.push('the key Secret must be read back with lookup (kept across upgrades)');
const sec = named(out, 'Secret', KEY_SECRET);
if (!sec) problems.push(`${KEY_SECRET} not rendered`);
else if (!/"helm\.sh\/resource-policy": keep/.test(sec)) problems.push(`${KEY_SECRET} must carry helm.sh/resource-policy: keep`);
const explicit = 'e'.repeat(48);
const v1 = named(render('--set', `osUI.connectionSecrets.secret=${explicit}`), 'Secret', KEY_SECRET);
const v2 = named(render('--set', `osUI.connectionSecrets.secret=${explicit}`), 'Secret', KEY_SECRET);
if (!v1?.includes(`OS_SECRETS_ENCRYPTION_KEY: "${explicit}"`) || v1 !== v2) problems.push('an explicit connectionSecrets.secret must render unchanged');
const ext = render('--set', 'osUI.connectionSecrets.existingSecret=my-key');
if (named(ext, 'Secret', KEY_SECRET)) problems.push('existingSecret set: the chart must not render its own key Secret');
for (const pod of ['os-ui', 'os-ui-worker']) if (keySource(named(ext, 'Deployment', pod))?.[1] !== 'my-key') problems.push(`existingSecret set: ${pod} must read my-key`);
try {
  render('--set', 'osUI.connectionSecrets.secret=short');
  problems.push('a key shorter than 32 characters must fail the render');
} catch {
  /* expected */
}

if (problems.length) {
  console.error(`${NAME}: FAILED\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`${NAME}: ok — Role grants exactly get/list/create/update/delete on secrets to os-ui; both pods use the kubernetes backend and the dedicated, kept key; explicit/existing/short key paths behave`);
