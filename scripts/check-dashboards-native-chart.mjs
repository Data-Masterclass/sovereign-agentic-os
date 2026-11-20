#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    WP-52 rollout — `osUI.dashboardsNative` is the chart switch for DASHBOARDS_NATIVE
 * USER STORY: As the operator I turn native dashboards (dbt saved queries + Vega-Lite) on with a
 *             values overlay, not a hand-edited Deployment that the next helm upgrade reverts.
 * ARCHITECTURE:
 *   - Renders the chart (worker enabled) and reads DASHBOARDS_NATIVE from BOTH Deployments: unset
 *     by default (the code reads unset as off, so the default render is unchanged), "true" when
 *     the value is true, unset when it is false.
 *   - Same skip rules as the other chart checks. Manual: `helm template charts/sovereign-agentic-os
 *     --set osUI.dashboardsNative=true | grep -A1 DASHBOARDS_NATIVE`.
 */
import { execFileSync } from 'node:child_process';
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
    console.error(`check-dashboards-native-chart: ${why} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` (or install helm) before the gate; a chart check may not silently skip in CI.`);
    process.exit(1);
  }
  console.log(`check-dashboards-native-chart: ${why} — SKIPPED (the manual command is in this script's header)`);
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

const args = (v) => ['template', CHART, '--set', 'osUI.worker.enabled=true', ...(v === undefined ? [] : ['--set', `osUI.dashboardsNative=${v}`])];

if (!helmAvailable()) skip('helm not on PATH');
if (!subchartsPresent()) skip('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');

const problems = [];
const cases = [
  { name: 'default values', v: undefined, want: undefined },
  { name: 'on', v: 'true', want: 'true' },
  { name: 'off', v: 'false', want: undefined },
];
for (const c of cases) {
  const found = deployments(execFileSync('helm', args(c.v), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  for (const pod of PODS) {
    const doc = found.get(pod);
    if (!doc) { problems.push(`${c.name}: ${pod} Deployment not rendered`); continue; }
    const got = envValue(doc, 'DASHBOARDS_NATIVE');
    if (got !== c.want) problems.push(`${c.name}: ${pod} DASHBOARDS_NATIVE=${JSON.stringify(got)}, expected ${JSON.stringify(c.want)}`);
  }
}

if (problems.length) {
  console.error('check-dashboards-native-chart FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-dashboards-native-chart: ok — ${cases.length} renders agree on both pods`);
