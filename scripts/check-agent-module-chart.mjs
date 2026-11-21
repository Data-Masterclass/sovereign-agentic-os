#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    WP-53d — the agent-module switch renders the same on os-ui and os-ui-worker
 * USER STORY: As the operator I want `osUI.agentGraphModule` to mean exactly what I wrote: off by
 *             default, a YAML list or a comma-separated string of domains, "*" only when I ask for
 *             every domain — and `enabled: true` with no domains to refuse to render rather than
 *             silently enable nothing (or everything).
 * ARCHITECTURE:
 *   - Renders the chart (worker enabled) for each case and reads AGENT_GRAPH_MODULE and
 *     AGENT_GRAPH_MODULE_DOMAINS from BOTH Deployments; the refusal cases must fail `helm template`.
 *   - WP-53e: with modules on, the worker mounts the os-repos PVC READ-ONLY at /repos and is
 *     scheduled onto os-ui's node (the PVC is ReadWriteOnce); with modules off it mounts nothing.
 *   - Same skip rules as the other chart checks: loud skip on a laptop without helm or subcharts,
 *     a hard failure in CI. Manual: `helm template charts/sovereign-agentic-os --set-json
 *     'osUI.agentGraphModule={"enabled":true,"domains":["test"]}' | grep -A1 AGENT_GRAPH_MODULE`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const PODS = ['os-ui', 'os-ui-worker'];

function helmAvailable() {
  try {
    execFileSync('helm', ['version', '--short'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function subchartsPresent() {
  const dir = join(CHART, 'charts');
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.tgz'));
}

function skip(why) {
  if (process.env.CI) {
    console.error(`check-agent-module-chart: ${why} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` (or install helm) before the gate; a chart check may not silently skip in CI.`);
    process.exit(1);
  }
  console.log(`check-agent-module-chart: ${why} — SKIPPED (the manual command is in this script's header)`);
  process.exit(0);
}

function deployments(text) {
  const out = new Map();
  for (const doc of text.split(/^---$/m)) {
    if (!/^kind: Deployment$/m.test(doc)) continue;
    const name = doc.match(/^metadata:\n(?:.*\n)*?\s{2}name: (\S+)$/m)?.[1] ?? doc.match(/^\s{2}name: (\S+)$/m)?.[1];
    if (name) out.set(name, doc);
  }
  return out;
}

function envValue(doc, name) {
  const m = doc.match(new RegExp(`^\\s+- name: ${name}\\n\\s+value: (.*)$`, 'm'));
  return m ? JSON.parse(m[1]) : undefined;
}

const args = (json) => ['template', CHART, '--set', 'osUI.worker.enabled=true', ...(json === undefined ? [] : ['--set-json', `osUI.agentGraphModule=${JSON.stringify(json)}`])];

if (!helmAvailable()) skip('helm not on PATH');
if (!subchartsPresent()) skip('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');

const problems = [];
const cases = [
  { name: 'default values', json: undefined, flag: 'false', domains: undefined },
  { name: 'a YAML list', json: { enabled: true, domains: ['test'] }, flag: 'true', domains: 'test' },
  { name: 'a YAML list of two', json: { enabled: true, domains: ['test', 'sales'] }, flag: 'true', domains: 'test,sales' },
  { name: 'a comma-separated string', json: { enabled: true, domains: ' test , sales ' }, flag: 'true', domains: 'test,sales' },
  { name: 'every domain, explicitly', json: { enabled: true, domains: '*' }, flag: 'true', domains: '*' },
  { name: 'off with domains listed', json: { enabled: false, domains: ['test'] }, flag: 'false', domains: 'test' },
];
for (const c of cases) {
  const found = deployments(execFileSync('helm', args(c.json), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  for (const pod of PODS) {
    const doc = found.get(pod);
    if (!doc) { problems.push(`${c.name}: ${pod} Deployment not rendered`); continue; }
    const flag = envValue(doc, 'AGENT_GRAPH_MODULE');
    const domains = envValue(doc, 'AGENT_GRAPH_MODULE_DOMAINS');
    if (flag !== c.flag) problems.push(`${c.name}: ${pod} AGENT_GRAPH_MODULE=${JSON.stringify(flag)}, expected ${JSON.stringify(c.flag)}`);
    if (domains !== c.domains) problems.push(`${c.name}: ${pod} AGENT_GRAPH_MODULE_DOMAINS=${JSON.stringify(domains)}, expected ${JSON.stringify(c.domains)}`);
  }
}
for (const c of [
  { name: 'enabled with an empty list', json: { enabled: true, domains: [] } },
  { name: 'enabled with an empty string', json: { enabled: true, domains: '' } },
  { name: 'enabled with no domains key', json: { enabled: true } },
  { name: 'enabled with only commas', json: { enabled: true, domains: ' , ' } },
]) {
  const r = spawnSync('helm', args(c.json), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) problems.push(`${c.name}: rendered — it must refuse (an empty list means no domain; use "*" for all)`);
  else if (!/agentGraphModule\.domains/.test(r.stderr)) problems.push(`${c.name}: failed for another reason: ${r.stderr.trim().slice(0, 300)}`);
}

// WP-53e: a module run reads committed graph.mjs files, so the worker needs the repos — read-only.
{
  const reposMount = (doc) => doc.match(/- name: os-repos\n\s+mountPath: (\S+)(\n\s+readOnly: (\w+))?/);
  const on = deployments(execFileSync('helm', args({ enabled: true, domains: ['test'] }), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).get('os-ui-worker') ?? '';
  const m = reposMount(on);
  if (!m) problems.push('modules on: os-ui-worker does not mount os-repos (runs fail with "no repository")');
  else {
    if (m[1] !== '/repos') problems.push(`modules on: os-ui-worker mounts os-repos at ${m[1]}, expected /repos`);
    if (m[3] !== 'true') problems.push('modules on: os-ui-worker mounts os-repos WRITABLE — it must be readOnly (os-ui is the one writer)');
  }
  if (!/claimName: os-repos\n\s+readOnly: true/.test(on)) problems.push('modules on: the os-ui-worker os-repos volume is not a read-only claim');
  if (!/podAffinity:\n\s+requiredDuringSchedulingIgnoredDuringExecution:[\s\S]*?app\.kubernetes\.io\/component: os-ui\n[\s\S]*?topologyKey: kubernetes\.io\/hostname/.test(on)) {
    problems.push('modules on: os-ui-worker has no required pod affinity to os-ui (the RWO volume attaches to one node)');
  }
  const off = deployments(execFileSync('helm', args(undefined), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).get('os-ui-worker') ?? '';
  if (/os-repos/.test(off) || /podAffinity/.test(off)) problems.push('modules off: os-ui-worker must mount no repos and carry no affinity');
}

if (problems.length) {
  console.error('check-agent-module-chart FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-agent-module-chart: ok — ${cases.length} renders agree on both pods; enabled with no domains refuses to render; the worker reads /repos read-only with modules on`);
