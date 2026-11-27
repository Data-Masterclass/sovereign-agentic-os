#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// FEATURE: App Builder on dev (workstream H) - os-ui's Roles in apps-dev/apps-prod are operator-applied on dev, and
//   this check keeps the operator's file equal to what the chart would render.
// USER STORY: As the owner I want the dev CI account unable to create os-ui's Roles (whoever may create them may grant
//   itself every right in them), without the operator's copy ever drifting from the chart.
// ARCHITECTURE: renders the chart with values.dev.yaml but `softwareRunner.environments.createOsUiRoles=true` (the
//   objects the chart WOULD create), takes every Role and RoleBinding in the App Builder env namespaces from
//   software-apps-envs.yaml and software-app-databases-rbac.yaml, keeps only what RBAC reads (kind, name, namespace,
//   rules / roleRef / subjects) and compares it with scripts/dev/manifests/app-builder-roles.yaml. A difference fails.
//   `--write` regenerates the file from the render (then review the diff). Also proves values.dev.yaml renders NONE of
//   them (the switch the file stands in for is really off on dev).
//   Usage: node scripts/check-dev-app-builder-roles.mjs [--write]   (needs helm and `helm dependency build`)
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const FILE = join(repo, 'scripts', 'dev', 'manifests', 'app-builder-roles.yaml');
const require = createRequire(resolve(repo, 'os-ui/package.json'));
const yaml = require('js-yaml');
const TEMPLATES = ['templates/base/os-ui/software-apps-envs.yaml', 'templates/base/os-ui/software-app-databases-rbac.yaml'];
const ENV_NS = ['apps-dev', 'apps-prod'];

const helmOk = (() => { try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const depsOk = existsSync(join(CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
if (!helmOk || !depsOk) {
  const msg = `check-dev-app-builder-roles: ${helmOk ? 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)' : 'helm not on PATH'} - SKIPPED`;
  if (process.env.CI) { console.error(msg); process.exit(1); }
  console.warn(msg); process.exit(0);
}

function rbacOf(extra) {
  const out = execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation',
    '--set', 'global.allowChartDefaultSecrets=true', '-f', join(repo, 'values.dev.yaml'), ...extra,
    ...TEMPLATES.flatMap((t) => ['--show-only', t])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return yaml.loadAll(out).filter((d) => d && ['Role', 'RoleBinding'].includes(d.kind) && ENV_NS.includes(d.metadata?.namespace));
}
/** What RBAC reads of an object, in a stable shape (labels are bookkeeping and may differ). */
const essence = (d) => ({
  apiVersion: d.apiVersion, kind: d.kind, metadata: { name: d.metadata.name, namespace: d.metadata.namespace },
  ...(d.kind === 'Role' ? { rules: d.rules } : { roleRef: d.roleRef, subjects: d.subjects }),
});
const key = (d) => `${d.kind}/${d.metadata.namespace}/${d.metadata.name}`;
const sorted = (list) => list.map(essence).sort((a, b) => key(a).localeCompare(key(b)));

const problems = [];
const wanted = sorted(rbacOf(['--set', 'softwareRunner.environments.createOsUiRoles=true']));
if (!wanted.some((d) => d.metadata.name === 'os-ui-app-env')) problems.push('the chart renders no os-ui-app-env Role with the App Builder dev values (did the switch go off?)');
const devRenders = rbacOf([]);
if (devRenders.length) problems.push(`values.dev.yaml still renders ${devRenders.map(key).join(', ')} (createOsUiRoles must be false on dev)`);

const header = `# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# os-ui's Roles and RoleBindings in the App Builder env namespaces on DEV - applied by the OPERATOR (admin kubeconfig),
# never by the CI account: values.dev.yaml sets softwareRunner.environments.createOsUiRoles: false, because an account
# allowed to create these Roles could grant itself every right in them (RBAC escalation prevention).
# GENERATED from the chart render (node scripts/check-dev-app-builder-roles.mjs --write); CI fails when it drifts.
# Apply after namespaces.yaml:  kubectl apply -f scripts/dev/manifests/app-builder-roles.yaml
`;
const render = (docs) => header + docs.map((d) => `---\n${yaml.dump(d, { lineWidth: 160, noRefs: true })}`).join('');

if (process.argv.includes('--write')) {
  writeFileSync(FILE, render(wanted));
  console.log(`check-dev-app-builder-roles: wrote ${FILE} (${wanted.length} objects)`);
} else {
  const have = existsSync(FILE) ? sorted(yaml.loadAll(readFileSync(FILE, 'utf8')).filter(Boolean)) : [];
  const a = JSON.stringify(have);
  const b = JSON.stringify(wanted);
  if (a !== b) {
    const hk = new Set(have.map(key));
    const wk = new Set(wanted.map(key));
    const missing = [...wk].filter((k) => !hk.has(k));
    const extra = [...hk].filter((k) => !wk.has(k));
    const changed = wanted.filter((w) => hk.has(key(w)) && JSON.stringify(have.find((h) => key(h) === key(w))) !== JSON.stringify(w)).map(key);
    problems.push(`scripts/dev/manifests/app-builder-roles.yaml drifted from the chart - missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'}; changed: ${changed.join(', ') || '-'} (regenerate with --write and review)`);
  }
}
if (problems.length) {
  console.error(`check-dev-app-builder-roles: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`check-dev-app-builder-roles: ok - ${wanted.length} operator-applied Role/RoleBinding objects equal the chart render; values.dev.yaml renders none of them`);
