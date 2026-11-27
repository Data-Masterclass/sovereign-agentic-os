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
//   The same holds for the SOFTWARE SCANNER's namespace (agentic-os-scans on dev): os-ui's Role there grants Secret
//   create/delete, so values.dev.yaml sets osUI.software.scanner.createOsUiRoles=false and the operator applies
//   scripts/dev/manifests/scanner-roles.yaml, checked the same way (one TARGETS entry each).
//   Usage: node scripts/check-dev-app-builder-roles.mjs [--write]   (needs helm and `helm dependency build`)
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const require = createRequire(resolve(repo, 'os-ui/package.json'));
const yaml = require('js-yaml');
const DEV_SCAN_NS = 'agentic-os-scans';
const TARGETS = [
  {
    file: join(repo, 'scripts', 'dev', 'manifests', 'app-builder-roles.yaml'),
    templates: ['templates/base/os-ui/software-apps-envs.yaml', 'templates/base/os-ui/software-app-databases-rbac.yaml'],
    namespaces: ['apps-dev', 'apps-prod'],
    on: ['--set', 'softwareRunner.environments.createOsUiRoles=true'],
    must: 'os-ui-app-env',
    switchName: 'softwareRunner.environments.createOsUiRoles',
    what: "os-ui's Roles and RoleBindings in the App Builder env namespaces",
    why: 'values.dev.yaml sets softwareRunner.environments.createOsUiRoles: false',
    applyAfter: 'namespaces.yaml',
  },
  {
    file: join(repo, 'scripts', 'dev', 'manifests', 'scanner-roles.yaml'),
    templates: ['templates/base/os-ui/software-scanner.yaml'],
    namespaces: [DEV_SCAN_NS],
    on: ['--set', 'osUI.software.scanner.createOsUiRoles=true'],
    must: 'os-ui-software-scanner',
    switchName: 'osUI.software.scanner.createOsUiRoles',
    what: "os-ui's (and the agent-run worker's) Role and RoleBinding in the software scanner's namespace",
    why: 'values.dev.yaml sets osUI.software.scanner.createOsUiRoles: false (the Role grants Secret create/delete)',
    applyAfter: 'namespaces.yaml',
  },
];

const helmOk = (() => { try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const depsOk = existsSync(join(CHART, 'charts')) && readdirSync(join(CHART, 'charts')).some((f) => f.endsWith('.tgz'));
if (!helmOk || !depsOk) {
  const msg = `check-dev-app-builder-roles: ${helmOk ? 'no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)' : 'helm not on PATH'} - SKIPPED`;
  if (process.env.CI) { console.error(msg); process.exit(1); }
  console.warn(msg); process.exit(0);
}

function rbacOf(t, extra) {
  const out = execFileSync('helm', ['template', 'agentic-os', CHART, '-n', 'agentic-os', '--skip-schema-validation',
    '--set', 'global.allowChartDefaultSecrets=true', '-f', join(repo, 'values.dev.yaml'), ...extra,
    ...t.templates.flatMap((x) => ['--show-only', x])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return yaml.loadAll(out).filter((d) => d && ['Role', 'RoleBinding'].includes(d.kind) && t.namespaces.includes(d.metadata?.namespace));
}
/** What RBAC reads of an object, in a stable shape (labels are bookkeeping and may differ). */
const essence = (d) => ({
  apiVersion: d.apiVersion, kind: d.kind, metadata: { name: d.metadata.name, namespace: d.metadata.namespace },
  ...(d.kind === 'Role' ? { rules: d.rules } : { roleRef: d.roleRef, subjects: d.subjects }),
});
const key = (d) => `${d.kind}/${d.metadata.namespace}/${d.metadata.name}`;
const sorted = (list) => list.map(essence).sort((a, b) => key(a).localeCompare(key(b)));
const rel = (f) => f.slice(repo.length + 1);

const problems = [];
let total = 0;
for (const t of TARGETS) {
  const wanted = sorted(rbacOf(t, t.on));
  total += wanted.length;
  if (!wanted.some((d) => d.metadata.name === t.must)) problems.push(`the chart renders no ${t.must} Role with the dev values and ${t.switchName}=true (did the switch go off?)`);
  const devRenders = rbacOf(t, []);
  if (devRenders.length) problems.push(`values.dev.yaml still renders ${devRenders.map(key).join(', ')} (${t.switchName} must be false on dev)`);

  const header = `# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# ${t.what} on DEV - applied by the OPERATOR (admin kubeconfig),
# never by the CI account: ${t.why}, because an account
# allowed to create these Roles could grant itself every right in them (RBAC escalation prevention).
# GENERATED from the chart render (node scripts/check-dev-app-builder-roles.mjs --write); CI fails when it drifts.
# Apply after ${t.applyAfter}:  kubectl apply -f ${rel(t.file)}
`;
  const render = (docs) => header + docs.map((d) => `---\n${yaml.dump(d, { lineWidth: 160, noRefs: true })}`).join('');

  if (process.argv.includes('--write')) {
    writeFileSync(t.file, render(wanted));
    console.log(`check-dev-app-builder-roles: wrote ${t.file} (${wanted.length} objects)`);
  } else {
    const have = existsSync(t.file) ? sorted(yaml.loadAll(readFileSync(t.file, 'utf8')).filter(Boolean)) : [];
    if (JSON.stringify(have) !== JSON.stringify(wanted)) {
      const hk = new Set(have.map(key));
      const wk = new Set(wanted.map(key));
      const missing = [...wk].filter((k) => !hk.has(k));
      const extra = [...hk].filter((k) => !wk.has(k));
      const changed = wanted.filter((w) => hk.has(key(w)) && JSON.stringify(have.find((h) => key(h) === key(w))) !== JSON.stringify(w)).map(key);
      problems.push(`${rel(t.file)} drifted from the chart - missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'}; changed: ${changed.join(', ') || '-'} (regenerate with --write and review)`);
    }
  }
}
if (problems.length) {
  console.error(`check-dev-app-builder-roles: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`check-dev-app-builder-roles: ok - ${total} operator-applied Role/RoleBinding objects equal the chart render; values.dev.yaml renders none of them`);
