#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test - the App Builder switch off changes nothing in the rendered chart (spec 2a)
 * USER STORY: As the owner I want proof that merging App Builder code changes nothing in prod while its switch is off:
 *             the os-ui Deployment renders byte-identical to the base branch, and no object appears or disappears,
 *             with the default values AND with prod-like values (runner on, Tekton off, environments unset).
 * ARCHITECTURE:
 *   - Renders the chart of HEAD and of the merge-base with a base ref (default `public/main`, else `origin/main`;
 *     override with `--base <ref>` or APP_BUILDER_BASE_REF), extracted with `git archive`, using the subchart
 *     tarballs of the working tree for both. Needs helm and `helm dependency build` done.
 *   - Per value set: the os-ui and os-ui-worker Deployments must be byte-identical; every non-Secret object must be
 *     byte-identical; Secrets must have the same keys (their values are `randAlphaNum` per render, so values are not
 *     comparable); the (kind, namespace, name) sets must be equal; SOFTWARE_APP_BUILDER must not appear. A positive
 *     twin renders HEAD with the switch on and requires SOFTWARE_APP_BUILDER=on in the os-ui Deployment.
 *   - Skips (exit 0, loudly) without helm, subcharts or the base ref, unless `--strict` or CI is set.
 *   Usage: node scripts/check-app-builder-flag-off.mjs [--base <ref>] [--strict]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART_REL = 'charts/sovereign-agentic-os';
const CHART = join(repo, CHART_REL);
const require = createRequire(resolve(repo, 'os-ui/package.json'));
const yaml = require('js-yaml');
const argv = process.argv.slice(2);
const strict = argv.includes('--strict') || !!process.env.CI;
const baseArg = argv[argv.indexOf('--base') + 1];

const VALUE_SETS = {
  default: [],
  'prod-like': ['--set', 'softwareRunner.enabled=true', '--set', 'osUI.software.tekton.enabled=false'],
};

function skip(msg) {
  if (strict) { console.error(`check-app-builder-flag-off: FAIL - ${msg}`); process.exit(1); }
  console.warn(`check-app-builder-flag-off: SKIPPED - ${msg}`);
  process.exit(0);
}
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const has = (ref) => { try { git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`); return true; } catch { return false; } };

try { execFileSync('helm', ['version', '--short'], { stdio: 'ignore' }); } catch { skip('helm not on PATH'); }
const tgz = existsSync(join(CHART, 'charts')) ? readdirSync(join(CHART, 'charts')).filter((f) => f.endsWith('.tgz')) : [];
if (!tgz.length) skip('no subchart .tgz (run `helm dependency build charts/sovereign-agentic-os`)');
const baseRef = baseArg && !baseArg.startsWith('--') ? baseArg : process.env.APP_BUILDER_BASE_REF || ['public/main', 'origin/main', 'main'].find(has);
if (!baseRef || !has(baseRef)) skip(`base ref not found (${baseRef ?? 'public/main|origin/main|main'})`);
const base = git('merge-base', 'HEAD', baseRef);

const tmp = mkdtempSync(join(tmpdir(), 'app-builder-flag-off-'));
const problems = [];
try {
  execFileSync('sh', ['-c', `git archive ${base} ${CHART_REL} | tar -x -C "${tmp}"`], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
  const baseChart = join(tmp, CHART_REL);
  mkdirSync(join(baseChart, 'charts'), { recursive: true });
  for (const f of tgz) copyFileSync(join(CHART, 'charts', f), join(baseChart, 'charts', f));

  const render = (chart, extra) => execFileSync('helm', ['template', 'agentic-os', chart, '-n', 'agentic-os', '--skip-schema-validation', ...extra], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const docs = (out) => {
    const m = new Map();
    for (const text of out.split(/^---\s*$/m)) {
      const d = yaml.load(text);
      if (!d || typeof d !== 'object' || !d.kind) continue;
      m.set(`${d.kind}/${d.metadata?.namespace ?? ''}/${d.metadata?.name ?? ''}`, { text: text.replace(/^# Source: .*$/m, '').trim(), doc: d });
    }
    return m;
  };

  for (const [label, values] of Object.entries(VALUE_SETS)) {
    const a = docs(render(baseChart, values));
    const b = docs(render(CHART, values));
    const added = [...b.keys()].filter((k) => !a.has(k));
    const removed = [...a.keys()].filter((k) => !b.has(k));
    if (added.length) problems.push(`[${label}] new objects with the switch off: ${added.join(', ')}`);
    if (removed.length) problems.push(`[${label}] objects gone with the switch off: ${removed.join(', ')}`);
    let deployments = 0;
    for (const [k, x] of a) {
      const y = b.get(k);
      if (!y) continue;
      if (x.doc.kind === 'Secret') {
        const keys = (d) => JSON.stringify(Object.keys({ ...(d.data ?? {}), ...(d.stringData ?? {}) }).sort());
        if (keys(x.doc) !== keys(y.doc)) problems.push(`[${label}] ${k}: Secret keys differ`);
        continue;
      }
      if (x.text !== y.text) problems.push(`[${label}] ${k} is not byte-identical with the switch off`);
      if (x.doc.kind === 'Deployment' && ['os-ui', 'os-ui-worker'].includes(x.doc.metadata?.name)) deployments += 1;
    }
    if (!deployments) problems.push(`[${label}] no os-ui Deployment rendered (the comparison would prove nothing)`);
    for (const [k, y] of b) if (y.text.includes('SOFTWARE_APP_BUILDER')) problems.push(`[${label}] ${k} carries SOFTWARE_APP_BUILDER with the switch off`);
    console.log(`check-app-builder-flag-off: [${label}] ${a.size} objects compared with ${base.slice(0, 12)} (${baseRef}), ${deployments} os-ui Deployment(s)`);
  }

  // positive twin: the switch on reaches the os-ui Deployment
  const on = docs(render(CHART, ['--set', 'softwareRunner.environments.enabled=true']));
  const ui = on.get('Deployment/agentic-os/os-ui') ?? [...on.values()].find((x) => x.doc.kind === 'Deployment' && x.doc.metadata?.name === 'os-ui');
  const env = ui?.doc?.spec?.template?.spec?.containers?.flatMap((c) => c.env ?? []) ?? [];
  if (!env.some((e) => e.name === 'SOFTWARE_APP_BUILDER' && e.value === 'on')) problems.push('positive twin: softwareRunner.environments.enabled=true does not render SOFTWARE_APP_BUILDER=on into os-ui');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error('check-app-builder-flag-off: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('check-app-builder-flag-off: ok - with the switch off the os-ui Deployments and every non-Secret object render byte-identical to the base, and no object is added or removed');
