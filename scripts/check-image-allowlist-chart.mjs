#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       repo tooling
 * FEATURE:    Chart test — the admin's image allowlist reaches BOTH os-ui pods, and only when set
 * USER STORY: As a platform admin I set `osUI.imageAllowlist` to decide which models may be sent
 *             images, and I need that list to be the one the pod that makes the model calls
 *             (`os-ui-worker`) obeys — not only the one the UI displays. And when I set nothing,
 *             the env must be absent so the built-in list in `os-ui/core/models/capabilities.ts`
 *             stays in force.
 * ARCHITECTURE:
 *   - Renders the chart three times and reads MODEL_IMAGE_ALLOWLIST off the RENDERED `os-ui`
 *     and `os-ui-worker` Deployments:
 *       (1) default values            → the env is ABSENT on both;
 *       (2) a list of two names       → the exact JSON array on both;
 *       (3) an empty list             → "[]" on both (an explicit "no model"), not absent.
 *   - The rendered value is JSON-parsed here the way the app parses it, so a quoting mistake in
 *     the template fails this check rather than silently falling back to the built-in list.
 *   - Same skip rules as `check-worker-env.mjs`: a loud skip on a laptop without helm or the
 *     subchart `.tgz` files, a hard FAILURE in CI. By hand:
 *       helm template charts/sovereign-agentic-os --set osUI.worker.enabled=true \
 *         --set-json 'osUI.imageAllowlist=["sovereign-vision"]' | grep -A1 MODEL_IMAGE_ALLOWLIST
 *   - No dependencies, no YAML parser.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHART = join(repo, 'charts', 'sovereign-agentic-os');
const ENV = 'MODEL_IMAGE_ALLOWLIST';
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
    console.error(`check-image-allowlist-chart: ${why} — FAILING because CI is set. Run \`helm dependency build charts/sovereign-agentic-os\` (or install helm) before the gate; a chart check may not silently skip in CI.`);
    process.exit(1);
  }
  console.log(`check-image-allowlist-chart: ${why} — SKIPPED (the manual command is in this script's header)`);
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

/** The env's rendered value in a Deployment: `undefined` when absent, else the YAML scalar decoded. */
function envValue(doc) {
  const m = doc.match(new RegExp(`^\\s+- name: ${ENV}\\n\\s+value: (.*)$`, 'm'));
  if (!m) return undefined;
  // The template emits a double-quoted YAML scalar, whose escapes are JSON's.
  return JSON.parse(m[1]);
}

function render(extra) {
  const text = execFileSync('helm', ['template', CHART, '--set', 'osUI.worker.enabled=true', ...extra], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return deployments(text);
}

if (!helmAvailable()) skip('helm not on PATH');
if (!subchartsPresent()) skip('no subchart .tgz in charts/sovereign-agentic-os/charts (run `helm dependency build charts/sovereign-agentic-os`)');

const problems = [];
const cases = [
  { name: 'default values', args: [], expect: undefined },
  { name: 'a list of two names', args: ['--set-json', 'osUI.imageAllowlist=["sovereign-vision","my-eu-vlm"]'], expect: ['sovereign-vision', 'my-eu-vlm'] },
  { name: 'an empty list', args: ['--set-json', 'osUI.imageAllowlist=[]'], expect: [] },
];
for (const c of cases) {
  const found = render(c.args);
  for (const pod of PODS) {
    const doc = found.get(pod);
    if (!doc) {
      problems.push(`${c.name}: ${pod} Deployment not rendered`);
      continue;
    }
    let raw;
    try {
      raw = envValue(doc);
    } catch (e) {
      problems.push(`${c.name}: ${pod} renders ${ENV} as an unreadable scalar (${e.message})`);
      continue;
    }
    if (c.expect === undefined) {
      if (raw !== undefined) problems.push(`${c.name}: ${pod} carries ${ENV}=${JSON.stringify(raw)} — it must be ABSENT so the built-in list stays in force`);
      continue;
    }
    if (raw === undefined) {
      problems.push(`${c.name}: ${pod} is MISSING ${ENV} — the admin's list would be ignored on this pod`);
      continue;
    }
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      problems.push(`${c.name}: ${pod} renders ${ENV}=${JSON.stringify(raw)}, which is not JSON — the app would fall back to the built-in list`);
      continue;
    }
    if (JSON.stringify(list) !== JSON.stringify(c.expect)) {
      problems.push(`${c.name}: ${pod} renders ${ENV}=${raw}, expected ${JSON.stringify(c.expect)}`);
    }
  }
}

if (problems.length) {
  console.error('check-image-allowlist-chart FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-image-allowlist-chart: ok — ${ENV} is absent by default, and a set list (including the empty one) renders identically on ${PODS.join(' and ')}`);
